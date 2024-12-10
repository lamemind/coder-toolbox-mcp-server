import {z} from "zod";
import {zodToJsonSchema} from "zod-to-json-schema";
import {ErrorCode, McpError, ToolSchema} from "@modelcontextprotocol/sdk/types.js";
import fs from 'fs/promises';
import {getJavaRootPath, searchInDirectory} from "../utils/javaFileSearch.js";

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

// Schema definition
export const ClassLocationSchema = z.object({
    className: z.string().min(1)
        .describe('The name of the class to find (case sensitive)'),
    sourceType: z.string()
        .regex(/^(source|test)$/)
        .optional()
        .describe('Source type to restrict the search (\'source\' or \'test\'), required if package path is specified'),
    packagePath: z.string()
        .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/)
        .optional()
        .describe('Optional package path to restrict the search (e.g. \'com.myself.myproject.something\'). If specified, source type must also be specified')
});

// Tool declaration
export const locateJavaClassTool = {
    name: "locate_java_class",
    description: "Locate and return a java class file from the project source or test code by its name, with optional package path",
    inputSchema: zodToJsonSchema(ClassLocationSchema) as ToolInput
};

// Function implementation
export async function handleLocateJavaClass(
    projectPath: string,
    args: unknown
) {
    const parsed = ClassLocationSchema.safeParse(args);
    if (!parsed.success)
        throw new McpError(ErrorCode.InvalidRequest, `Invalid arguments for locate_java_class: ${parsed.error}`);

    try {
        const searchPath = getJavaRootPath(projectPath, parsed.data.sourceType, parsed.data.packagePath);
        try {
            await fs.access(searchPath);
        } catch {
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({found: false, searchPath})
                }]
            };
        }

        const result = await searchInDirectory(searchPath, parsed.data.className, projectPath);
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
