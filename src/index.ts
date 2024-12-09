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
import * as os from "node:os";
import {z} from "zod";
import {zodToJsonSchema} from "zod-to-json-schema";

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
const ClassLocationSchema = z.object({
    className: z.string().min(1)
        .describe('The name of the class to find (case sensitive)'),
    packagePath: z.string()
        .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/)
        .optional()
        .describe('Optional package path to restrict the search (e.g. \'com.myself.myproject.something\')'),
    isTestClass: z.boolean()
        .default(false)
        .describe('Whether to search for a test class (true) or source class (false)')
});

const AddMethodSchema = ClassLocationSchema.extend({
    methodBody: z.string().min(1)
        .describe('Full method declaration including modifiers, return type, name, parameters and body')
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
        async function searchInDirectory(dirPath: string): Promise<FileSearchResult> {
            try {
                const entries = await fs.readdir(dirPath, {withFileTypes: true});

                for (const entry of entries) {
                    const fullPath = path.join(dirPath, entry.name);

                    if (entry.isDirectory()) {
                        const result = await searchInDirectory(fullPath);
                        if (result.found) return result;
                    } else if (entry.isFile()) {
                        const expectedFileName = `${className}.java`;
                        if (entry.name === expectedFileName) {
                            const content = await fs.readFile(fullPath, 'utf-8');
                            const relativePath = path.relative(projectPath, fullPath);
                            return {
                                found: true,
                                filepath: relativePath.replace(/\\/g, '/'),
                                content
                            };
                        }
                    }
                }
            } catch (error) {
                console.error(`Error searching directory ${dirPath}:`, error);
            }
            return {found: false};
        }

        return await searchInDirectory(searchPath);
    }

    private getJavaRootPath(isTestClass: boolean, packagePath?: string): string {
        let searchPath = path.join(
            this.projectPath,
            'src',
            isTestClass ? 'test' : 'main',
            'java'
        );

        if (packagePath) {
            searchPath = path.join(searchPath, ...packagePath.split('.'));
        }

        return searchPath;
    }

    private setupHandlers(): void {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [{
                name: "get_test_logs",
                description: "Get all test execution logs",
                inputSchema: {
                    type: "object",
                    properties: {},
                    required: []
                }
            }, {
                name: "locate_class",
                description: "Locate a class file in the project source code by its name, with optional package path and type filtering",
                inputSchema: zodToJsonSchema(ClassLocationSchema) as ToolInput
            }, {
                name: "add_method",
                description: "Add a new method to an existing Java class",
                inputSchema: zodToJsonSchema(AddMethodSchema) as ToolInput
            }]
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            if (request.params.name === "locate_class") {
                const parsed = ClassLocationSchema.safeParse(request.params.arguments);
                if (!parsed.success)
                    throw new Error(`Invalid arguments for locate_class: ${parsed.error}`);

                try {
                    const searchPath = this.getJavaRootPath(parsed.data.isTestClass, parsed.data.packagePath);
                    try {
                        await fs.access(searchPath);
                    } catch {
                        return {
                            content: [{
                                type: "text",
                                text: JSON.stringify({found: false})
                            }]
                        };
                    }

                    const result = await this.searchJavaFile(searchPath, parsed.data.className);
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify(result)
                        }]
                    };
                } catch (error) {
                    throw new McpError(
                        ErrorCode.InternalError,
                        `Failed to search for class: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }

            if (request.params.name === "add_method") {
                const parsed = AddMethodSchema.safeParse(request.params.arguments);
                if (!parsed.success)
                    throw new Error(`Invalid arguments for add_method: ${parsed.error}`);

                try {
                    const searchPath = this.getJavaRootPath(parsed.data.isTestClass, parsed.data.packagePath);
                    const result = await this.searchJavaFile(searchPath, parsed.data.className);

                    if (!result.found || !result.filepath || !result.content) {
                        return {
                            content: [{
                                type: "text",
                                text: JSON.stringify({
                                    success: false,
                                    error: "Class file not found"
                                })
                            }]
                        };
                    }

                    const fileContent = result.content;
                    const classEndMatch = fileContent.match(/^}/m);
                    if (!classEndMatch || !classEndMatch.index) {
                        return {
                            content: [{
                                type: "text",
                                text: JSON.stringify({
                                    success: false,
                                    error: "Invalid class file format - missing closing brace"
                                })
                            }]
                        };
                    }

                    const insertPosition = classEndMatch.index;
                    const newContent = fileContent.slice(0, insertPosition) +
                        "\n\n" + parsed.data.methodBody + "\n" +
                        fileContent.slice(insertPosition);

                    const fullPath = path.join(this.projectPath, result.filepath);
                    await fs.writeFile(fullPath, newContent, 'utf-8');

                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                success: true,
                                filepath: result.filepath
                            })
                        }]
                    };
                } catch (error) {
                    throw new McpError(
                        ErrorCode.InternalError,
                        `Failed to add method: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }

            if (request.params.name === "get_test_logs") {
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
