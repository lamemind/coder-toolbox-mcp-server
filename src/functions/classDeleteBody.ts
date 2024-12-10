import {z} from "zod";
import {zodToJsonSchema} from "zod-to-json-schema";
import {ErrorCode, McpError, ToolSchema} from "@modelcontextprotocol/sdk/types.js";
import {ClassLocationSchema} from "./locateJavaClass.js";
import {getJavaRootPath, searchInDirectory} from "../utils/javaFileSearch.js";
import {applyFileEdits} from "../utils/fileEdits.js";

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

// Schema definition
export const ClassDeleteBodySchema = ClassLocationSchema.extend({
    targetContent: z.string().min(1)
        .describe('The content to delete from the class body'),
    dryRun: z.boolean().default(false)
        .describe('Preview changes using git-style diff format')
});

// Tool declaration
export const classDeleteBodyTool = {
    name: "class_delete_body",
    description: "Delete specific content from a Java class body",
    inputSchema: zodToJsonSchema(ClassDeleteBodySchema) as ToolInput
};

// Function implementation
export async function deleteClassBody(
    projectPath: string,
    args: unknown
) {
    const parsed = ClassDeleteBodySchema.safeParse(args);
    if (!parsed.success)
        throw new McpError(ErrorCode.InvalidRequest, `Invalid arguments for class_delete_body: ${parsed.error}`);

    try {
        const searchPath = getJavaRootPath(projectPath, parsed.data.sourceType, parsed.data.packagePath);
        const result = await searchInDirectory(searchPath, parsed.data.className, projectPath);

        if (!result.found || !result.filepath)
            throw new McpError(ErrorCode.InvalidRequest, `Class file not found: ${parsed.data.className}`);

        const edits = [{
            oldText: parsed.data.targetContent,
            newText: ''
        }];

        return await applyFileEdits(result.filepath, edits, parsed.data.dryRun);
    } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError(ErrorCode.InternalError, `Failed to delete class body content: ${error instanceof Error ? error.message : String(error)}`);
    }
}

