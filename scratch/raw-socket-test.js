const net = require('net');

const client = new net.Socket();
const host = 'aivaah-db.cb02yqk007pr.ap-south-1.rds.amazonaws.com';
const port = 5432;

console.log(`Connecting to ${host}:${port}...`);

client.connect(port, host, () => {
    console.log('✅ TCP Connection Established!');
    // Send a startup message (SSL request)
    // 8 bytes: length (8), code (80877103)
    const buf = Buffer.alloc(8);
    buf.writeInt32BE(8, 0);
    buf.writeInt32BE(80877103, 4);
    client.write(buf);
    console.log('Sent SSL request...');
});

client.on('data', (data) => {
    console.log('Received data:', data.toString());
    client.destroy();
});

client.on('error', (err) => {
    console.error('❌ Socket Error:', err.message);
});

client.on('close', () => {
    console.log('Connection closed');
});

setTimeout(() => {
    console.log('Timeout reached, destroying socket');
    client.destroy();
}, 10000);
