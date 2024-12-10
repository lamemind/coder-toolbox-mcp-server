import {z} from "zod";
import {zodToJsonSchema} from "zod-to-json-schema";
import path from 'path';
import fs from 'fs/promises';
import {ClassLocationSchema} from "./locateJavaClass.js";
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
        .describe('The package path where to create the java class file (e.g. \'com.myself.myproject.something\')')
});

// Tool declaration
export const createJavaClassTool = {
    name: "create_java_class",
    description: "Create a new Java class file in the project source or test code with package path and source/test specification",
    inputSchema: zodToJsonSchema(ClassCreateSchema) as ToolInput
};

// Function implementation
export async function createJavaClass(
    projectPath: string,
    args: unknown
): Promise<{ success: boolean; filepath?: string; error?: string }> {
    const parsed = ClassLocationSchema.safeParse(args);
    if (!parsed.success)
        throw new McpError(ErrorCode.InvalidRequest, `Invalid arguments for locate_java_class: ${parsed.error}`);

    try {
        const searchPath = getJavaRootPath(projectPath, parsed.data.sourceType, parsed.data.packagePath);

        // Ensure directory exists
        await fs.mkdir(searchPath, {recursive: true});

        const filePath = path.join(searchPath, `${parsed.data.className}.java`);

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
        let content = '';
        if (parsed.data.packagePath)
            content += `package ${parsed.data.packagePath};\n\n`;
        content += `public class ${parsed.data.className} {\n\n}`;

        // Write the file
        await fs.writeFile(filePath, content, 'utf-8');

        return {
            success: true,
            filepath: path.relative(projectPath, filePath).replace(/\\/g, '/')
        };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
