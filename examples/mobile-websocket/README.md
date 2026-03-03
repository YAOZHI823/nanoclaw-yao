# WebSocket Mobile Examples

This directory contains example code for connecting mobile apps to NanoClaw via WebSocket.

## Protocol

### Connection Flow

1. **Connect** to `ws://<nanoclaw-ip>:9876`
2. **Send pairing request**:
   ```json
   {
     "type": "pairing_request",
     "deviceId": "your-device-unique-id"
   }
   ```
3. **Receive pairing code** from server (check NanoClaw logs)
4. **Verify pairing**:
   ```json
   {
     "type": "pairing_verify",
     "deviceId": "your-device-unique-id",
     "pairingCode": "ABCD12"
   }
   ```
5. **On success**, start sending/receiving messages

### Message Format

**Send message** (client → server):
```json
{
  "type": "message",
  "content": "Hello, ask Claude something"
}
```

**Receive message** (server → client):
```json
{
  "type": "message",
  "from": "assistant",
  "content": "Hello! How can I help you?",
  "timestamp": 1234567890
}
```

### Keep-alive

Send periodic ping/pong to maintain connection:
```json
{"type": "ping"}
// Response: {"type": "pong"}
```

### Offline Message Queue

When the device is offline (connection lost), messages from AI are automatically queued. When the device reconnects, queued messages are automatically delivered.

- Maximum 50 messages per device
- Queue is cleared after delivery

### File Transfer

**Upload file** (client → server):
```json
// Start
{
  "type": "file_start",
  "fileId": "unique-file-id",
  "fileName": "document.pdf",
  "fileSize": 1024000,
  "mimeType": "application/pdf"
}

// Chunks (base64 encoded)
{
  "type": "file_chunk",
  "fileId": "unique-file-id",
  "chunk": "base64-encoded-data"
}
// ... repeat for all chunks

// End
{
  "type": "file_end",
  "fileId": "unique-file-id"
}
```

**Download file** (server → client): Same format as upload, chunks are delivered in sequence.

## Examples

| Platform | File |
|----------|------|
| iOS (Swift) | `ios/NanoClawClient.swift` |
| Android (Kotlin) | `android/MainActivity.kt` |
| Node.js test | `test-client.js` |
