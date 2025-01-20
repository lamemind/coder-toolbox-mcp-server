import {z} from "zod";
import {zodToJsonSchema} from "zod-to-json-schema";
import path from 'path';
import fs from 'fs/promises';
import {ErrorCode, McpError, ToolSchema} from "@modelcontextprotocol/sdk/types.js";
import {getJavaRootPath} from "../utils/javaFileSearch.js";

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

// Schema definition
export const ClassCreateSchema = z.object({
    className: z.string().min(1)
        .describe('The name of the class to create (case sensitive)'),
    sourceType: z.string()
        .regex(/^(source|test)$/)
        .describe('The source type where to create the java class file (\'source\' or \'test\')'),
    packagePath: z.string()
        .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/)
        .describe('The package path where to create the java class file (e.g. \'com.myself.myproject.something\')'),
    content: z.string()
        .optional()
        .describe('Optional initial content for the class. Must include a valid class declaration matching className and packagePath.')
});

// Tool declaration
export const createJavaClassTool = {
    name: "create_java_class",
    description: `Create a new Java class file. Examples:
- Simple class:
  className: "MyClass", sourceType: "source", packagePath: "com.example"
- With initial content:
  content: "public class MyClass { 
    private String name;
    public MyClass(String name) {
        this.name = name;
    }
  }"
Note: if content is provided, the class declaration must match className and packagePath`,
    inputSchema: zodToJsonSchema(ClassCreateSchema) as ToolInput
};

function validateContent(content: string | undefined, className: string, packagePath: string): void {
    if (!content) return;

    const packageMatch = content.match(/^\s*package\s+([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)\s*;/m);
    if (!packageMatch || packageMatch[1] !== packagePath) {
        throw new McpError(ErrorCode.InvalidRequest,
            `Content package declaration must be 'package ${packagePath};'`);
    }

    const classMatch = content.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (!classMatch || classMatch[1] !== className) {
        throw new McpError(ErrorCode.InvalidRequest,
            `Content class declaration must match className: ${className}`);
    }
}

// Function implementation
export async function createJavaClass(
    projectPath: string,
    args: unknown
): Promise<{ success: boolean; filepath?: string; error?: string }> {
    const parsed = ClassCreateSchema.safeParse(args);
    if (!parsed.success)
        throw new McpError(ErrorCode.InvalidRequest, `Invalid arguments for locate_java_class: ${parsed.error}`);

    try {
        const {className, sourceType, packagePath, content} = parsed.data;
        if (content) {
            validateContent(content, className, packagePath);
        }

        const searchPath = getJavaRootPath(projectPath, sourceType, packagePath);

        // Ensure directory exists
        await fs.mkdir(searchPath, {recursive: true});

        const filePath = path.join(searchPath, `${className}.java`);

        // Check if file already exists
        try {
            await fs.access(filePath);
            return {
                success: false,
                error: "Class file already exists"
            };
        } catch {
            // File doesn't exist, we can proceed
        }

        // Create class content
        let fileContent = content;
        if (!fileContent) {
            fileContent = `package ${packagePath};\n\npublic class ${className} {\n\n}`;
        }

        // Write the file
        await fs.writeFile(filePath, fileContent, 'utf-8');

        return {
            success: true,
            filepath: path.relative(projectPath, filePath).replace(/\\/g, '/')
        };
    } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError(ErrorCode.InternalError, `Failed to create class: ${error instanceof Error ? error.message : String(error)}`);
    }
}
