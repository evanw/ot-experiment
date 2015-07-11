var log = false;

var Type = {
	NOP: 0,
	DEL: 1,
	INS: 2
};

function nop() {
	return {type: Type.NOP};
}

function del(index) {
	return {type: Type.DEL, index: index};
}

function ins(index, data) {
	return {type: Type.INS, index: index, data: data};
}

function apply(document, command) {
	switch (command.type) {
		case Type.NOP: {
			return document;
		}

		case Type.DEL: {
			if (command.index < 0 || command.index >= document.length) {
				throw new Error('deletion index ' + command.index + ' is out of range for document of length ' + document.length);
			}
			return document.slice(0, command.index).concat(document.slice(command.index + 1));
		}

		case Type.INS: {
			if (command.index < 0 || command.index > document.length) {
				throw new Error('insertion index ' + command.index + ' is out of range for document of length ' + document.length);
			}
			return document.slice(0, command.index).concat(command.data, document.slice(command.index));
		}
	}
	throw new Error('pattern matching failed');
}

// xform(a, b) = (a', b') where apply(apply(doc, a), b') == apply(apply(doc, b), a')
// Ported from https://github.com/fitzgen/erl-ot/blob/master/src/ot.erl
function xform(a, b) {
	switch (a.type) {
		case Type.NOP: {
			switch (b.type) {
				case Type.NOP: {
					return [nop(), nop()];
				}
				case Type.DEL: {
					return [del(b.index), nop()];
				}
				case Type.INS: {
					return [ins(b.index, b.data), nop()];
				}
			}
			break;
		}

		case Type.DEL: {
			switch (b.type) {
				case Type.NOP: {
					return [nop(), del(a.index)];
				}
				case Type.DEL: {
					return (
						a.index < b.index ? [del(a.index), del(b.index - 1)] :
						a.index > b.index ? [del(a.index - 1), del(b.index)] :
						[nop(), nop()]);
				}
				case Type.INS: {
					return (
						a.index < b.index ? [del(a.index), ins(b.index - 1, b.data)] :
						[del(a.index + 1), ins(b.index, b.data)]);
				}
			}
			break;
		}

		case Type.INS: {
			switch (b.type) {
				case Type.NOP: {
					return [nop(), ins(a.index, a.data)];
				}
				case Type.DEL: {
					return (
						a.index > b.index ? [ins(a.index - 1, a.data), del(b.index)] :
						[ins(a.index, a.data), del(b.index + 1)]);
				}
				case Type.INS: {
					return (
						a.index < b.index || a.index === b.index && a.data > b.data ? [ins(a.index, a.data), ins(b.index + 1, b.data)] :
						a.index > b.index || a.index === b.index && a.data < b.data ? [ins(a.index + 1, a.data), ins(b.index, b.data)] :
						[nop(), nop()]);
				}
			}
			break;
		}
	}

	throw new Error('pattern matching failed');
}

function permutations(values) {
	if (values.length < 2) {
		return [values];
	}
	var results = [];
	for (var i = 0; i < values.length; i++) {
		var choice = values[i];
		var rest = values.slice(0, i);
		rest.push.apply(rest, values.slice(i + 1));
		permutations(rest).forEach(function(order) {
			order.push(choice);
			results.push(order);
		});
	}
	return results;
}

function mixedPermutations(prefix, a, b) {
	if (a.length === 0) return [prefix.concat(b)];
	if (b.length === 0) return [prefix.concat(a)];
	return mixedPermutations(prefix.concat(a[0]), a.slice(1), b).concat(
		mixedPermutations(prefix.concat(b[0]), a, b.slice(1)));
}

function insertOrDelete(length, index, value) {
	if (index < length) {
		return del(index);
	} else {
		return ins(index - length, value);
	}
}

function dumpDocument(document) {
	return JSON.stringify(document.join(''));
}

function dumpCommands(commands) {
	return '[' + commands.map(function(command) {
		switch (command.type) {
			case Type.NOP: return 'nop';
			case Type.DEL: return 'del(' + command.index + ')';
			case Type.INS: return 'ins(' + command.index + ', ' + command.data + ')';
		}
		throw new Error('pattern matching failed');
	}).join(', ') + ']';
}

function check(expected, actual) {
	if (log) console.log('expected ' + dumpDocument(expected) + ', got ' + dumpDocument(actual));
	if (dumpDocument(expected) !== dumpDocument(actual)) {
		throw new Error('mismatch');
	}
}

////////////////////////////////////////////////////////////////////////////////

function Server(document) {
	this.document = document;
	this.connections = [];
	this.sequence = 0;
}

Server.prototype.connect = function(client) {
	this.connections.push({
		client: client,
		outgoing: [],
		sequence: 0,
		sequenceOffset: 0,
	});
};

Server.prototype.receive = function(client) {
	for (var i = 0; i < this.connections.length; i++) {
		var connection = this.connections[i];
		if (connection.client !== client) {
			continue;
		}

		if (log) console.log(client + ' has ' + client.outgoing.length + ' packets to send to ' + this);
		while (client.outgoing.length > 0) {
			var packet = client.outgoing.shift();
			var sequence = packet.sequence;

			// Artificially increment this packet's sequence number if it forms part of
			// a chain of commands from the client that all don't have conflicts. This
			// is more efficient than ignoring all except the first command. To avoid
			// this optimization, just comment out the increment statement.
			if (connection.sequence === sequence) {
				sequence += connection.sequenceOffset;
			}

			if (sequence !== this.sequence) {
				if (log) console.log(this + ' got ' + dumpCommands([packet.command]) + ' with sequence ' + packet.sequence + ' (adjusted to ' + sequence + ') from ' + client + ', ignored');
				continue;
			}

			this.document = apply(this.document, packet.command);
			this.sequence++;

			// Advance all subsequent packet sequences so the client can commit a run
			// of changes without all but the first one being ignored.
			if (connection.sequence !== packet.sequence) {
				connection.sequenceOffset = 0;
			}
			connection.sequence = packet.sequence;
			connection.sequenceOffset++;

			if (log) console.log(this + ' got ' + dumpCommands([packet.command]) + ' with sequence ' + packet.sequence + ' (adjusted to ' + sequence + ') from ' + client + ', used');
			this.broadcast(packet.command);
		}
	}
};

Server.prototype.broadcast = function(command) {
	this.connections.forEach(function(connection) {
		connection.outgoing.push(command);
	});
};

Server.prototype.send = function(client) {
	this.connections.forEach(function(connection) {
		if (connection.client === client) {
			if (log) console.log(this + ' has ' + connection.outgoing.length + ' packets to send to ' + client);
			while (connection.outgoing.length > 0) {
				client.receive(connection.outgoing.shift());
			}
		}
	}, this);
};

Server.prototype.toString = function() {
	return '[server, document ' + dumpDocument(this.document) + ', sequence ' + this.sequence + ']';
};

////////////////////////////////////////////////////////////////////////////////

function Client(name, document, server) {
	this.name = name;
	this.document = document;
	this.server = server;
	this.local = [];
	this.outgoing = [];
	this.sequence = 0;
	server.connect(this);
}

Client.prototype.apply = function(command) {
	this.document = apply(this.document, command);
	if (log) console.log(this + ' applied ' + dumpCommands([command]));
	this.local.push(command);
	this.send(command);
};

Client.prototype.send = function(command) {
	if (command.type !== Type.NOP) {
		this.outgoing.push({
			sequence: this.sequence,
			command: command,
		});
		if (log) console.log(this + ' sent ' + dumpCommands([command]));
	}
};

Client.prototype.receive = function(command) {
	this.sequence++;
	if (log) console.log(this + ' got ' + dumpCommands([command]));

	for (var i = 0; i < this.local.length; i++) {
		var local = this.local[i];
		if (command.type === Type.NOP) {
			this.send(local);
			continue;
		}

		var both = xform(local, command);
		if (log) console.log(this + ' ran xform on ' + dumpCommands([local, command]) + ', got ' + dumpCommands(both));
		local = both[0];
		command = both[1];

		if (local.type === Type.NOP) {
			this.local.splice(i--, 1);
		} else {
			this.local[i] = local;
			this.send(local);
		}
	}

	this.document = apply(this.document, command);
	if (log) console.log(this + ' applied ' + dumpCommands([command]));
};

Client.prototype.toString = function() {
	return '[client ' + this.name + ', document ' + dumpDocument(this.document) + ', sequence ' + this.sequence + ']';
};

////////////////////////////////////////////////////////////////////////////////

function bruteForce() {
	var document = ['1', '2', '3'];

	console.log('simulate two different clients making an edit at once');
	for (var a = 0; a <= 2 * document.length; a++) {
		var A = insertOrDelete(document.length, a, 'A');
		for (var b = 0; b <= 2 * document.length; b++) {
			var B = insertOrDelete(document.length, b, 'B');
			permutations([A, B]).forEach(function(order) {
				var X = order[0];
				var Y = order[1];

				var server = new Server(document);
				var clientX = new Client('X', document, server);
				var clientY = new Client('Y', document, server);

				if (log) console.log('commands are ' + dumpCommands([X, Y]) + ', document is ' + dumpDocument(document));
				clientX.apply(X);
				clientY.apply(Y);

				for (var i = 0; i < 2; i++) {
					server.receive(clientX);
					server.receive(clientY);

					server.send(clientX);
					server.send(clientY);
				}

				check(server.document, clientX.document);
				check(server.document, clientY.document);
				if (log) console.log();
			});
		}
	}

	console.log('simulate three different clients all making an edit at once');
	for (var a = 0; a <= 2 * document.length; a++) {
		var A = insertOrDelete(document.length, a, 'A');
		for (var b = 0; b <= 2 * document.length; b++) {
			var B = insertOrDelete(document.length, b, 'B');
			for (var c = 0; c <= 2 * document.length; c++) {
				var C = insertOrDelete(document.length, c, 'C');
				permutations([A, B, C]).forEach(function(order) {
					var X = order[0];
					var Y = order[1];
					var Z = order[2];

					var server = new Server(document);
					var clientX = new Client('X', document, server);
					var clientY = new Client('Y', document, server);
					var clientZ = new Client('Z', document, server);

					if (log) console.log('commands are ' + dumpCommands([X, Y, Z]) + ', document is ' + dumpDocument(document));
					clientX.apply(X);
					clientY.apply(Y);
					clientZ.apply(Z);

					for (var i = 0; i < 3; i++) {
						server.receive(clientX);
						server.receive(clientY);
						server.receive(clientZ);

						server.send(clientX);
						server.send(clientY);
						server.send(clientZ);
					}

					check(server.document, clientX.document);
					check(server.document, clientY.document);
					check(server.document, clientZ.document);
					if (log) console.log();
				});
			}
		}
	}

	console.log('simulate two different clients making two edits at once');
	for (var a0 = 0; a0 <= 2 * document.length; a0++) {
		var A0 = insertOrDelete(document.length, a0, 'A');
		var limitA = apply(document, A0).length;

		for (var a1 = 0; a1 <= 2 * limitA; a1++) {
			var A1 = insertOrDelete(limitA, a1, 'a');

			for (var b0 = 0; b0 <= 2 * document.length; b0++) {
				var B0 = insertOrDelete(document.length, b0, 'B');
				var limitB = apply(document, B0).length;

				for (var b1 = 0; b1 <= 2 * limitB; b1++) {
					var B1 = insertOrDelete(limitB, b1, 'b');

					mixedPermutations([], [A0, A1], [B0, B1]).forEach(function(order) {
						var server = new Server(document);
						var clientX = new Client('X', document, server);
						var clientY = new Client('Y', document, server);

						if (log) console.log('commands are ' + dumpCommands([A0, A1]) + ' and ' + dumpCommands([B0, B1]) + ', document is ' + dumpDocument(document));
						order.forEach(function(command) {
							if (command === A0) clientX.apply(A0);
							if (command === A1) clientX.apply(A1);
							if (command === B0) clientY.apply(B0);
							if (command === B1) clientY.apply(B1);
						});

						for (var i = 0; i < 4; i++) {
							server.receive(clientX);
							server.receive(clientY);
							server.send(clientX);
							server.send(clientY);
						}

						check(server.document, clientX.document);
						check(server.document, clientY.document);
						if (log) console.log();
					});
				}
			}
		}
	}

	console.log('all tests passed');
}

bruteForce();
