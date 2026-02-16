const { spawn } = require('child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

async function test() {
  console.log('Starting MCP test...');

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js']
  });

  const client = new Client({ name: 'test', version: '0.0.0' });

  console.log('Connecting...');
  await client.connect(transport);
  console.log('Connected!');

  console.log('Listing tools...');
  const tools = await client.listTools();
  console.log('Tools:', tools.tools.map(t => t.name));

  console.log('Calling chrome_screenshot...');
  const result = await client.callTool({ name: 'chrome_screenshot', arguments: { url: 'http://localhost:5173/' } });
  console.log('Result:', JSON.stringify(result, null, 2));

  await client.close();
  console.log('SUCCESS');
}

test().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
