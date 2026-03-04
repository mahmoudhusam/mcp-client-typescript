import Groq from 'groq-sdk';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'groq-sdk/resources/chat/completions';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import readline from 'readline/promises';
import dotenv from 'dotenv';

dotenv.config();

const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!GROQ_API_KEY) {
  throw new Error('GROQ_API_KEY is not set');
}

class MCPClient {
  private mcp: Client;
  private groq: Groq;
  private transport: StdioClientTransport | null = null;
  private tools: ChatCompletionTool[] = [];

  constructor() {
    this.groq = new Groq({
      apiKey: GROQ_API_KEY,
    });
    this.mcp = new Client({
      name: 'mcp-client-cli',
      version: '1.0.0',
    });
  }
  //method will go here

  async connectToServer(serverScriptPath: string) {
    try {
      const isJs = serverScriptPath.endsWith('.js');
      const isPy = serverScriptPath.endsWith('.py');
      if (!isJs && !isPy) {
        throw new Error('Server script must be a .js or .py file');
      }
      const command = isPy
        ? process.platform === 'win32'
          ? 'python'
          : 'python3'
        : process.execPath;

      this.transport = new StdioClientTransport({
        command,
        args: [serverScriptPath],
      });
      await this.mcp.connect(this.transport);

      const toolsResult = await this.mcp.listTools();
      this.tools = toolsResult.tools.map((tool) => {
        return {
          type: 'function' as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        };
      });
      console.log(
        'Connected to server with tools:',
        this.tools.map((tool) => tool.function.name),
      );
    } catch (e) {
      console.log('Failed to connect to MCP server: ', e);
      throw e;
    }
  }
  async processQuery(query: string) {
    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'user',
        content: query,
      },
    ];

    let response = await this.groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile', // or 'mixtral-8x7b-32768'
      messages,
      tools: this.tools,
      max_tokens: 1000,
    });

    const finalText = [];
    const choice = response.choices[0];

    if (choice.message.content) {
      finalText.push(choice.message.content);
    }

    // Handle tool calls
    if (choice.message.tool_calls) {
      for (const toolCall of choice.message.tool_calls) {
        const toolName = toolCall.function.name;
        const toolArgs = JSON.parse(toolCall.function.arguments);

        finalText.push(
          `[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`,
        );

        const result = await this.mcp.callTool({
          name: toolName,
          arguments: toolArgs,
        });

        // Add assistant message and tool result to conversation
        messages.push(choice.message);
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result.content),
        });

        // Get final response with tool results
        const finalResponse = await this.groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages,
          max_tokens: 1000,
        });

        if (finalResponse.choices[0].message.content) {
          finalText.push(finalResponse.choices[0].message.content);
        }
      }
    }

    return finalText.join('\n');
  }
  async chatLoop() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      console.log('\nMCP Client Started!');
      console.log("Type your queries or 'quit' to exit.");

      while (true) {
        const message = await rl.question('\nQuery: ');
        if (message.toLowerCase() === 'quit') {
          break;
        }
        const response = await this.processQuery(message);
        console.log('\n' + response);
      }
    } finally {
      rl.close();
    }
  }

  async cleanup() {
    await this.mcp.close();
  }
}
async function main() {
  if (process.argv.length < 3) {
    console.log('Usage: node index.ts <path_to_server_script>');
    return;
  }
  const mcpClient = new MCPClient();
  try {
    await mcpClient.connectToServer(process.argv[2]);
    await mcpClient.chatLoop();
  } catch (e) {
    console.error('Error:', e);
    await mcpClient.cleanup();
    process.exit(1);
  } finally {
    await mcpClient.cleanup();
    process.exit(0);
  }
}

main();
