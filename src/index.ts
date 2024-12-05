import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError} from "@modelcontextprotocol/sdk/types.js";
import fs from 'fs/promises';
import path from 'path';
import * as os from "node:os";

// Command line argument parsing
const args = process.argv.slice(2);
if (args.length === 0) {
    console.error("Usage: mcp-server-filesystem <allowed-directory> [additional-directories...]");
    process.exit(1);
}

// Normalize all paths consistently
function normalizePath(p: string): string {
    return path.normalize(p).toLowerCase();
}

function expandHome(filepath: string): string {
    if (filepath.startsWith('~/') || filepath === '~') {
        return path.join(os.homedir(), filepath.slice(1));
    }
    return filepath;
}

// Store allowed directories in normalized form
const logDirectory = normalizePath(path.resolve(expandHome(args[0])));

// Validate that all directories exist and are accessible
await Promise.all([logDirectory].map(async (dir) => {
    try {
        const stats = await fs.stat(dir);
        if (!stats.isDirectory()) {
            console.error(`Error: ${dir} is not a directory`);
            process.exit(1);
        }
    } catch (error) {
        console.error(`Error accessing directory ${dir}:`, error);
        process.exit(1);
    }
}));

class TestingServer {
    private server: Server;
    private readonly logPath: string;

    constructor() {
        this.logPath = logDirectory;

        this.server = new Server({
            name: "java-testing-server",
            version: "1.0.0"
        }, {
            capabilities: {
                tools: {}
            }
        });

        this.setupHandlers();
    }

    private setupHandlers(): void {
        // Solo uno strumento per leggere i log
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [{
                name: "get_test_logs",
                description: "Get all test execution logs",
                inputSchema: {
                    type: "object",
                    properties: {},
                    required: []
                }
            }]
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            if (request.params.name !== "get_test_logs") {
                throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
            }

            try {
                const files = await fs.readdir(this.logPath);
                const logFiles = files.filter(file => file.endsWith('.log'));
                const MAX_LINES_PER_FILE = 100;

                const logContents = await Promise.all(
                    logFiles.map(async file => {
                        const content = await fs.readFile(path.join(this.logPath, file), 'utf-8');
                        const lines = content.split('\n');
                        const truncated = lines.length > MAX_LINES_PER_FILE;
                        const limitedContent = lines.slice(-MAX_LINES_PER_FILE).join('\n');

                        return `=== ${file} ${truncated ? `(showing last ${MAX_LINES_PER_FILE} lines of ${lines.length})` : ''} ===\n${limitedContent}\n`;
                    })
                );

                return {
                    content: [{
                        type: "text",
                        text: logContents.join('\n')
                    }]
                };
            } catch (error) {
                if (error instanceof Error) {
                    throw new McpError(
                        ErrorCode.InternalError,
                        `Failed to read log files: ${error.message}`
                    );
                }
                throw error;
            }
        });
    }

    async run(): Promise<void> {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error("Test logs MCP server running on stdio");
    }
}


const server = new TestingServer();
server.run().catch(console.error);
