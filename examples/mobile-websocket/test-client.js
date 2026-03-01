#!/usr/bin/env node

/**
 * Simple Node.js WebSocket client for testing NanoClaw
 * Usage:
 *   node test-client.js                    # Request pairing, then enter code
 *   node test-client.js PAIRING_CODE       # Verify with code directly
 */

import WebSocket from 'ws';
import readline from 'readline';

// Usage: node test-client.js [ws://url] [pairing_code]
const serverUrl = process.argv[2]?.startsWith('ws://') ? process.argv[2] : 'ws://localhost:9876';

// Reuse deviceId from file if exists, otherwise generate new one
import { readFileSync, writeFileSync, existsSync } from 'fs';
const deviceIdFile = '/tmp/nanoclaw-device-id';
let deviceId = existsSync(deviceIdFile) ? readFileSync(deviceIdFile, 'utf8') : `test-device-${Date.now()}`;
if (!existsSync(deviceIdFile)) {
  writeFileSync(deviceIdFile, deviceId);
}
console.log(`Device ID: ${deviceId}`);

const ws = new WebSocket(serverUrl);
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function send(obj) {
  ws.send(JSON.stringify(obj));
  console.log('→', JSON.stringify(obj));
}

function handleMessage(data) {
  const msg = JSON.parse(data);
  console.log('←', JSON.stringify(msg));

  switch (msg.type) {
    case 'pairing_challenge':
      console.log(`\n📱 PAIRING CODE: ${msg.pairingCode}\n`);
      console.log('Enter the pairing code above (or press Enter to exit):');
      rl.question('> ', (code) => {
        if (code.trim()) {
          console.log('Verifying pairing...');
          send({
            type: 'pairing_verify',
            deviceId,
            pairingCode: code.trim().toUpperCase(),
          });
        } else {
          ws.close();
          process.exit(0);
        }
      });
      break;

    case 'pairing_success':
      console.log('\n✅ Paired successfully!\n');
      console.log('Now you can send messages. Type and press Enter:\n');
      promptMessage();
      break;

    case 'pairing_failed':
      console.error('\n❌ Pairing failed:', msg.message);
      ws.close();
      process.exit(1);
      break;

    case 'message':
      console.log(`\n🤖 Assistant: ${msg.content}\n`);
      promptMessage();
      break;

    case 'error':
      console.error('❌ Error:', msg.message);
      break;

    default:
      break;
  }
}

function promptMessage() {
  rl.question('You: ', (input) => {
    if (input.trim().toLowerCase() === 'exit') {
      ws.close();
      rl.close();
      process.exit(0);
    }

    if (input.trim()) {
      send({
        type: 'message',
        content: input,
      });
    } else {
      promptMessage();
    }
  });
}

ws.on('open', () => {
  console.log(`Connected to ${serverUrl}\n`);

  // Check if a pairing code was provided as argument
  // Can be: test-client.js CODE  or  test-client.js ws://url CODE
  const pairingCode = process.argv[2]?.startsWith('ws://') ? process.argv[3] : process.argv[2];
  if (pairingCode && pairingCode.length === 6) {
    console.log('Verifying pairing with code:', pairingCode);
    send({
      type: 'pairing_verify',
      deviceId,
      pairingCode: pairingCode.toUpperCase(),
    });
  } else {
    console.log('Requesting pairing...\n');
    send({
      type: 'pairing_request',
      deviceId,
    });
  }
});

ws.on('message', handleMessage);

ws.on('close', () => {
  console.log('\nDisconnected');
  rl.close();
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

// Send ping every 30 seconds to keep connection alive
setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    send({ type: 'ping' });
  }
}, 30000);
