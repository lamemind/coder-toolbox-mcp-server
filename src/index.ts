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
import {zodToJsonSchema} from "zod-to-json-schema";
import {applyFileEdits} from "./utils/fileEdits.js";
import {expandHome, normalizePath} from "./utils/paths.js";
import {ClassLocationSchema, handleLocateJavaClass, locateJavaClassTool} from "./functions/locateJavaClass.js";
import {getJavaRootPath, searchInDirectory} from "./utils/javaFileSearch.js";
import {createJavaClass, createJavaClassTool} from "./functions/createJavaClass.js";

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
const AddClassBodySchema = ClassLocationSchema.extend({
    classBody: z.string().min(1)
        .describe('The class body to add, including fields, methods, constructors, etc.')
});

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
    private readonly projectPath: string;

    constructor() {
        this.projectPath = projectPath;
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
            }, locateJavaClassTool, createJavaClassTool, {
                name: "class_add_body",
                description: "Add new content to an existing Java class body, including fields, methods, constructors, etc.",
                inputSchema: zodToJsonSchema(AddClassBodySchema) as ToolInput
            }, {
                name: "class_replace_body",
                description: "Replace the a portion of the existing Java class body with new content",
                inputSchema: zodToJsonSchema(EditFileArgsSchema) as ToolInput
            }]
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            if (request.params.name === "locate_java_class")
                return handleLocateJavaClass(projectPath, request.params.arguments);

            if (request.params.name === "create_java_class")
                return createJavaClass(projectPath, request.params.arguments);

            if (request.params.name === "class_add_body") {
                const parsed = AddClassBodySchema.safeParse(request.params.arguments);
                if (!parsed.success)
                    throw new Error(`Invalid arguments for class_add_body: ${parsed.error}`);

                try {
                    const searchPath = getJavaRootPath(projectPath, parsed.data.sourceType, parsed.data.packagePath);
                    const result = await this.searchJavaFile(searchPath, parsed.data.className);
                    if (!result.found || !result.filepath || !result.content)
                        throw new Error(`Class file not found: ${parsed.data.className}`);

                    const fileContent = result.content;
                    const classEndMatch = fileContent.match(/^}/m);
                    if (!classEndMatch || !classEndMatch.index)
                        throw new Error("Invalid class file format - missing closing brace");

                    const insertPosition = classEndMatch.index;
                    const newContent = fileContent.slice(0, insertPosition) +
                        "\n\n" + parsed.data.classBody + "\n" +
                        fileContent.slice(insertPosition);

                    const fullPath = path.join(this.projectPath, result.filepath);
                    await fs.writeFile(fullPath, newContent, 'utf-8');

                    return {
                        content: [{
                            type: "text", text: JSON.stringify({
                                success: true,
                                filepath: result.filepath
                            })
                        }]
                    };
                } catch (error) {
                    throw new McpError(
                        ErrorCode.InternalError,
                        `Failed to add class body: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }

            if (request.params.name === "class_replace_body") {
                const parsed = EditFileArgsSchema.safeParse(args);
                if (!parsed.success)
                    throw new Error(`Invalid arguments for class_replace_body: ${parsed.error}`);

                try {
                    const searchPath = getJavaRootPath(projectPath, parsed.data.sourceType, parsed.data.packagePath);
                    const result = await this.searchJavaFile(searchPath, parsed.data.className);
                    if (!result.found || !result.filepath || !result.content)
                        throw new Error(`Class file not found: ${parsed.data.className}`);

                    const editResult = await applyFileEdits(result.filepath, parsed.data.edits, parsed.data.dryRun);
                    return {
                        content: [{type: "text", text: editResult}],
                    };
                } catch (error) {
                    throw new McpError(
                        ErrorCode.InternalError,
                        `Failed to add class body: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }

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
