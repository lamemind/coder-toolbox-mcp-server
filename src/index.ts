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
import { diffLines, createTwoFilesPatch } from 'diff';

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
    sourceType: z.string()
        .regex(/^(source|test)$/)
        .optional()
        .describe('Optional source type to restrict the search (\'source\' or \'test\')'),
    packagePath: z.string()
        .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/)
        .optional()
        .describe('Optional package path to restrict the search (e.g. \'com.myself.myproject.something\')')
});

const ClassCreateSchema = z.object({
    className: z.string().min(1)
        .describe('The name of the class to create (case sensitive)'),
    sourceType: z.string()
        .regex(/^(source|test)$/)
        .describe('The source type where to create the java class file (\'source\' or \'test\')'),
    packagePath: z.string()
        .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/)
        .describe('The package path where to create the java class file (e.g. \'com.myself.myproject.something\')')
});

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

function normalizeLineEndings(text: string): string {
    return text.replace(/\r\n/g, '\n');
}

function createUnifiedDiff(originalContent: string, newContent: string, filepath: string = 'file'): string {
    // Ensure consistent line endings for diff
    const normalizedOriginal = normalizeLineEndings(originalContent);
    const normalizedNew = normalizeLineEndings(newContent);

    return createTwoFilesPatch(
        filepath,
        filepath,
        normalizedOriginal,
        normalizedNew,
        'original',
        'modified'
    );
}

async function applyFileEdits(
    filePath: string,
    edits: Array<{ oldText: string, newText: string }>,
    dryRun = false
): Promise<string> {
    // Read file content and normalize line endings
    const content = normalizeLineEndings(await fs.readFile(filePath, 'utf-8'));

    // Apply edits sequentially
    let modifiedContent = content;
    for (const edit of edits) {
        const normalizedOld = normalizeLineEndings(edit.oldText);
        const normalizedNew = normalizeLineEndings(edit.newText);

        // If exact match exists, use it
        if (modifiedContent.includes(normalizedOld)) {
            modifiedContent = modifiedContent.replace(normalizedOld, normalizedNew);
            continue;
        }

        // Otherwise, try line-by-line matching with flexibility for whitespace
        const oldLines = normalizedOld.split('\n');
        const contentLines = modifiedContent.split('\n');
        let matchFound = false;

        for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
            const potentialMatch = contentLines.slice(i, i + oldLines.length);

            // Compare lines with normalized whitespace
            const isMatch = oldLines.every((oldLine, j) => {
                const contentLine = potentialMatch[j];
                return oldLine.trim() === contentLine.trim();
            });

            if (isMatch) {
                // Preserve original indentation of first line
                const originalIndent = contentLines[i].match(/^\s*/)?.[0] || '';
                const newLines = normalizedNew.split('\n').map((line, j) => {
                    if (j === 0) return originalIndent + line.trimStart();
                    // For subsequent lines, try to preserve relative indentation
                    const oldIndent = oldLines[j]?.match(/^\s*/)?.[0] || '';
                    const newIndent = line.match(/^\s*/)?.[0] || '';
                    if (oldIndent && newIndent) {
                        const relativeIndent = newIndent.length - oldIndent.length;
                        return originalIndent + ' '.repeat(Math.max(0, relativeIndent)) + line.trimStart();
                    }
                    return line;
                });

                contentLines.splice(i, oldLines.length, ...newLines);
                modifiedContent = contentLines.join('\n');
                matchFound = true;
                break;
            }
        }

        if (!matchFound) {
            throw new Error(`Could not find exact match for edit:\n${edit.oldText}`);
        }
    }

    // Create unified diff
    const diff = createUnifiedDiff(content, modifiedContent, filePath);

    // Format diff with appropriate number of backticks
    let numBackticks = 3;
    while (diff.includes('`'.repeat(numBackticks))) {
        numBackticks++;
    }
    const formattedDiff = `${'`'.repeat(numBackticks)}diff\n${diff}${'`'.repeat(numBackticks)}\n\n`;

    if (!dryRun) {
        await fs.writeFile(filePath, modifiedContent, 'utf-8');
    }

    return formattedDiff;
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

    private getJavaRootPath(sourceType: string | undefined, packagePath?: string): string {
        let searchPath = path.join(this.projectPath, 'src');
        if (sourceType === 'test')
            searchPath = path.join(searchPath, 'test');
        else if (sourceType === 'source')
            searchPath = path.join(this.projectPath, 'main');
        searchPath = path.join(searchPath, 'java');

        if (packagePath) {
            searchPath = path.join(searchPath, ...packagePath.split('.'));
        }

        return searchPath;
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
            }, {
                name: "locate_java_class",
                description: "Locate and return a java class file from the project source or test code by its name, with optional package path",
                inputSchema: zodToJsonSchema(ClassLocationSchema) as ToolInput
            }, {
                name: "create_java_class",
                description: "Create a new Java class file in the project source or test code with package path and source/test specification",
                inputSchema: zodToJsonSchema(ClassCreateSchema) as ToolInput
            }, {
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
            if (request.params.name === "locate_java_class") {
                const parsed = ClassLocationSchema.safeParse(request.params.arguments);
                if (!parsed.success)
                    throw new Error(`Invalid arguments for locate_java_class: ${parsed.error}`);

                try {
                    const searchPath = this.getJavaRootPath(parsed.data.sourceType, parsed.data.packagePath);
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

            if (request.params.name === "create_java_class") {
                const parsed = ClassCreateSchema.safeParse(request.params.arguments);
                if (!parsed.success)
                    throw new Error(`Invalid arguments for create_java_class: ${parsed.error}`);

                try {
                    const searchPath = this.getJavaRootPath(parsed.data.sourceType, parsed.data.packagePath);

                    // Ensure directory exists
                    await fs.mkdir(searchPath, {recursive: true});

                    const filePath = path.join(searchPath, `${parsed.data.className}.java`);

                    // Check if file already exists
                    try {
                        await fs.access(filePath);
                        return {
                            content: [{
                                type: "text",
                                text: JSON.stringify({
                                    success: false,
                                    error: "Class file already exists"
                                })
                            }]
                        };
                    } catch {
                        // File doesn't exist, we can proceed
                    }

                    // Create class content
                    let content = '';
                    if (parsed.data.packagePath) {
                        content += `package ${parsed.data.packagePath};\n\n`;
                    }
                    content += `public class ${parsed.data.className} {\n}\n}`;

                    // Write the file
                    await fs.writeFile(filePath, content, 'utf-8');

                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                success: true,
                                filepath: path.relative(this.projectPath, filePath).replace(/\\/g, '/')
                            })
                        }]
                    };
                } catch (error) {
                    throw new McpError(
                        ErrorCode.InternalError,
                        `Failed to create class: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }

            if (request.params.name === "class_add_body") {
                const parsed = AddClassBodySchema.safeParse(request.params.arguments);
                if (!parsed.success)
                    throw new Error(`Invalid arguments for class_add_body: ${parsed.error}`);

                try {
                    const searchPath = this.getJavaRootPath(parsed.data.sourceType, parsed.data.packagePath);
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
                    const searchPath = this.getJavaRootPath(parsed.data.sourceType, parsed.data.packagePath);
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
