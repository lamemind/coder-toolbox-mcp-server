import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
    ToolSchema
} from "@modelcontextprotocol/sdk/types.js";
import fs from 'fs/promises';
import path from 'path';
import {z} from "zod";
import {expandHome, normalizePath} from "./utils/paths.js";
import {ClassLocationSchema, handleLocateJavaClass, locateJavaClassTool} from "./functions/locateJavaClass.js";
import {searchInDirectory} from "./utils/javaFileSearch.js";
import {createJavaClass, createJavaClassTool} from "./functions/createJavaClass.js";
import {addClassBody, classAddBodyTool} from "./functions/classAddBody.js";
import {classReplaceBodyTool, replaceClassBody} from "./functions/classReplaceBody.js";
import {classDeleteBodyTool, deleteClassBody} from "./functions/classDeleteBody.js";
import {classRewriteHeaderTool, rewriteClassHeader} from "./functions/classRewriteHeader.js";

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

// Schema definitions
const EditOperation = z.object({
    oldText: z.string().describe('Text to search for - must match exactly'),
    newText: z.string().describe('Text to replace with')
});

const EditFileArgsSchema = ClassLocationSchema.extend({
    edits: z.array(EditOperation),
    dryRun: z.boolean().default(false).describe('Preview changes using git-style diff format')
});

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

interface FileSearchResult {
    found: boolean;
    filepath?: string;
    content?: string;
}

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

    private async searchJavaFile(searchPath: string, className: string): Promise<FileSearchResult> {
        return await searchInDirectory(searchPath, className, projectPath);
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
            }, locateJavaClassTool, createJavaClassTool, classAddBodyTool, classReplaceBodyTool, classDeleteBodyTool, classRewriteHeaderTool]
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            if (request.params.name === "locate_java_class")
                return handleLocateJavaClass(projectPath, request.params.arguments)
                    .then(result => ({content: [{type: "text", text: JSON.stringify(result)}]}));

            if (request.params.name === "create_java_class")
                return createJavaClass(projectPath, request.params.arguments)
                    .then(result => ({content: [{type: "text", text: JSON.stringify(result)}]}));

            if (request.params.name === "class_add_body")
                return addClassBody(projectPath, request.params.arguments)
                    .then(result => ({content: [{type: "text", text: JSON.stringify(result)}]}));

            if (request.params.name === "class_replace_body")
                return replaceClassBody(projectPath, request.params.arguments)
                    .then(result => ({content: [{type: "text", text: result}]}));

            if (request.params.name === "class_delete_body")
                return deleteClassBody(projectPath, request.params.arguments)
                    .then(result => ({content: [{type: "text", text: result}]}));

            if (request.params.name === "class_rewrite_header")
                return rewriteClassHeader(projectPath, request.params.arguments)
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
