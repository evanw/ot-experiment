// Turn on logging for debugging (slows stuff down by 50x)
var log = false;

var Type = {
	NOP: 0,
	DEL: 1,
	INS: 2
};

// Null command (emitted when two commands cancel out)
function nop() {
	return {type: Type.NOP};
}

// Deletion command
function del(index) {
	return {type: Type.DEL, index: index};
}

// Insertion command
function ins(index, data) {
	return {type: Type.INS, index: index, data: data};
}

// Documents are arrays of strings
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

////////////////////////////////////////////////////////////////////////////////
// This simulates a simple server and assumes all clients start off with the
// same document. This means it doesn't handle connections coming and going.

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

			// This document is only used for debugging, and can be removed completely.
			this.document = apply(this.document, packet.command);

			// Increase the sequence number so we ignore out-of-date commands.
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
// This simulates a simple client and assumes the server starts off with the
// same document. Clients will have to send the same command multiple times if
// that command is rejected by the server.

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

		// Null commands apparently need to be special-cased or local commands get
		// turned into null commands during the operational transformation.
		if (command.type === Type.NOP) {
			this.send(local);
			continue;
		}

		// I got hung up on this part for a while. Requiring the local commands to
		// be transformed along with the remote commands was counter-intuitive.
		var both = xform(local, command);
		if (log) console.log(this + ' ran xform on ' + dumpCommands([local, command]) + ', got ' + dumpCommands(both));
		local = both[0];
		command = both[1];

		// Local commands are "acknowledged" by the server as an inherent property
		// of the transformation. Identical commands always cancel out completely.
		if (local.type === Type.NOP) {
			this.local.splice(i--, 1);
		}

		// Send rejected changes back up to the server to try again. It would be
		// wise to delay sending these commands until the client is done receiving
		// a batch of commands from the server, but commands are just sent up to
		// the server repeatedly for now.
		else {
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
// This is some testing code to try to ensure that everything works. Instead of
// randomly fuzzing the input and checking for errors, this code attempts to
// generate all possible interactions of a certain type. Hopefully I got the
// case generation correct.

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

function allPossibleCommandSequencesOfLength(document, length, base) {
	if (length === 0) {
		return [];
	}

	// Find all possible single commands for this document
	var commands = [];
	for (var i = 0; i <= document.length; i++) {
		commands.push(ins(i, base));
	}
	for (var i = 0; i < document.length; i++) {
		commands.push(del(i));
	}

	// Use each command as the start of a sequence recursively
	var sequences = [];
	commands.forEach(function(command) {
		if (length === 1) {
			sequences.push([command]);
		} else {
			var nested = allPossibleCommandSequencesOfLength(apply(document, command), length - 1, String.fromCharCode(base.charCodeAt(0) + 1));
			nested.forEach(function(sequence) {
				sequence.unshift(command);
			});
			sequences.push.apply(sequences, nested);
		}
	});

	return sequences;
}

function allPossibleCommandSequencesOfLengthUpTo(document, length, base) {
	var sequences = [];
	for (var i = 0; i < length; i++) {
		sequences.push.apply(sequences, allPossibleCommandSequencesOfLength(document, i + 1, base));
	}
	return sequences;
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

function bruteForce() {
	var document = ['1', '2', '3'];

	console.log('all possible sequences of length up to 2');
	allPossibleCommandSequencesOfLengthUpTo(document, 2, 'A').forEach(function(commands0) {
		allPossibleCommandSequencesOfLengthUpTo(document, 2, 'X').forEach(function(commands1) {
			mixedPermutations([], commands0, commands1).forEach(function(order) {
				var server = new Server(document);
				var client0 = new Client('0', document, server);
				var client1 = new Client('1', document, server);

				if (log) console.log('commands are ' + dumpCommands(commands0) + ' and ' + dumpCommands(commands1) + ', document is ' + dumpDocument(document));
				order.forEach(function(command) {
					var client = commands0.indexOf(command) >= 0 ? client0 : client1;
					client.apply(command);
					server.receive(client);
				});

				for (var i = 0; i < commands0.length + commands1.length; i++) {
					server.receive(client0);
					server.receive(client1);
					server.send(client0);
					server.send(client1);
				}

				check(server.document, client0.document);
				check(server.document, client1.document);
				if (log) console.log();
			});
		});
	});

	console.log('all tests passed');
}

bruteForce();
