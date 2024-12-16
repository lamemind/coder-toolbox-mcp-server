import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError} from "@modelcontextprotocol/sdk/types.js";
import fs from 'fs/promises';
import path from 'path';
import {expandHome, normalizePath} from "./utils/paths.js";

import {handleLocateJavaClass, locateJavaClassTool} from "./functions/locateJavaClass.js";
import {createJavaClass, createJavaClassTool} from "./functions/createJavaClass.js";
import {javaCodebaseRetrieve, javaCodebaseRetrieveTool} from "./functions/javaCodebaseRetrieve.js";
import {classRewriteFullTool, rewriteClassFull} from "./functions/classRewriteFull.js";
import {classAddContent, classAddContentTool} from "./functions/classAddContent.js";
import {classReplaceContent, classReplaceContentTool} from "./functions/classReplaceContent.js";
import {classDeleteContent, classDeleteContentTool} from "./functions/classDeleteContent.js";

// Command line argument parsing
const args = process.argv.slice(2);
if (args.length === 0) {
    console.error("Usage: mcp-server-filesystem <allowed-directory> [additional-directories...]");
    process.exit(1);
}

// Store allowed directories in normalized form
const projectPath = normalizePath(path.resolve(expandHome(args[0])));
const logDirectory = normalizePath(path.resolve(expandHome(args[1])));

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
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [{
                name: "get_test_execution_logs",
                description: "Retrieve the test execution logs. Test are meant to run continuously and log their output to a file.",
                inputSchema: {
                    type: "object",
                    properties: {},
                    required: []
                }
            }, locateJavaClassTool,
                createJavaClassTool,
                javaCodebaseRetrieveTool,
                classAddContentTool,
                classReplaceContentTool,
                classDeleteContentTool,
                classRewriteFullTool
            ]
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            if (request.params.name === "locate_java_class")
                return handleLocateJavaClass(projectPath, request.params.arguments)
                    .then(result => ({content: [{type: "text", text: JSON.stringify(result)}]}));

            if (request.params.name === "java_codebase_retrieve")
                return javaCodebaseRetrieve(projectPath, request.params.arguments)
                    .then(result => ({content: [{type: "text", text: JSON.stringify(result)}]}));

            if (request.params.name === "create_java_class")
                return createJavaClass(projectPath, request.params.arguments)
                    .then(result => ({content: [{type: "text", text: JSON.stringify(result)}]}));

            if (request.params.name === "class_rewrite_full")
                return rewriteClassFull(projectPath, request.params.arguments)
                    .then(result => ({content: [{type: "text", text: result}]}));

            if (request.params.name === "class_add_content")
                return classAddContent(projectPath, request.params.arguments)
                    .then(result => ({content: [{type: "text", text: JSON.stringify(result)}]}));

            if (request.params.name === "class_replace_content")
                return classReplaceContent(projectPath, request.params.arguments)
                    .then(result => ({content: [{type: "text", text: result}]}));

            if (request.params.name === "class_delete_content")
                return classDeleteContent(projectPath, request.params.arguments)
                    .then(result => ({content: [{type: "text", text: result}]}));

            if (request.params.name === "get_test_execution_logs") {
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
            }

            throw new McpError(
                ErrorCode.InvalidRequest,
                `Unknown tool name: ${request.params.name}`
            );
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
