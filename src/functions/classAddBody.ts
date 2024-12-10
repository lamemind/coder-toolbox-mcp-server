import {z} from "zod";
import {zodToJsonSchema} from "zod-to-json-schema";
import fs from 'fs/promises';
import path from 'path';
import {ErrorCode, McpError, ToolSchema} from "@modelcontextprotocol/sdk/types.js";
import {ClassLocationSchema} from "./locateJavaClass.js";
import {getJavaRootPath, searchInDirectory} from "../utils/javaFileSearch.js";

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

// Schema definition
export const ClassAddBodySchema = ClassLocationSchema.extend({
    classBody: z.string().min(1)
        .describe('The class body to add, including fields, methods, constructors, etc.')
});

// Tool declaration
export const classAddBodyTool = {
    name: "class_add_body",
    description: "Add new content to an existing Java class body, including fields, methods, constructors, etc.",
    inputSchema: zodToJsonSchema(ClassAddBodySchema) as ToolInput
};

// Function implementation
export async function addClassBody(
    projectPath: string,
    args: unknown
) {
    const parsed = ClassAddBodySchema.safeParse(args);
    if (!parsed.success)
        throw new McpError(ErrorCode.InvalidRequest, `Invalid arguments for class_add_body: ${parsed.error}`);

    try {
        const searchPath = getJavaRootPath(projectPath, parsed.data.sourceType, parsed.data.packagePath);
        const result = await searchInDirectory(searchPath, parsed.data.className, projectPath);

        if (!result.found || !result.filepath || !result.content)
            throw new McpError(ErrorCode.InvalidRequest, `Class file not found: ${parsed.data.className}`);

        const fileContent = result.content;
        const classEndMatch = fileContent.match(/^}/m);

        if (!classEndMatch || !classEndMatch.index)
            throw new McpError(ErrorCode.InvalidRequest, "Invalid class file format - missing closing brace");

        const insertPosition = classEndMatch.index;
        const newContent = fileContent.slice(0, insertPosition) +
            "\n\n" + parsed.data.classBody + "\n" +
            fileContent.slice(insertPosition);

        const fullPath = path.join(projectPath, result.filepath);
        await fs.writeFile(fullPath, newContent, 'utf-8');

        return {
            success: true,
            filepath: result.filepath
        };
    } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError(ErrorCode.InternalError, `Failed to add class body: ${error instanceof Error ? error.message : String(error)}`);
    }
}
