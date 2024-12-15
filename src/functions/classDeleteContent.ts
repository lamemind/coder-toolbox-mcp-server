import {z} from "zod";
import {zodToJsonSchema} from "zod-to-json-schema";
import {ErrorCode, McpError, ToolSchema} from "@modelcontextprotocol/sdk/types.js";
import {ClassLocationSchema} from "./locateJavaClass.js";
import {getJavaRootPath, searchInDirectory} from "../utils/javaFileSearch.js";
import {applyFileEdits} from "../utils/fileEdits.js";
import path from "path";

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

export const ClassDeleteContentSchema = ClassLocationSchema.extend({
    targetContent: z.string().min(1)
        .describe('The content to delete from the class file'),
    dryRun: z.boolean().default(false)
        .describe('Preview changes using git-style diff format')
});

export const classDeleteContentTool = {
    name: "class_delete_content",
    description: `Delete any content from a Java class file. Examples:
- Remove unused imports: 
  targetContent: "import java.util.List;"
- Delete a method:
  targetContent: "public void unusedMethod() { ... }"
- Remove annotations:
  targetContent: "@Deprecated\n@SuppressWarnings("unused")"
- Delete interface implementation:
  targetContent: "implements UnusedInterface"
`
};

export async function classDeleteContent(
    projectPath: string,
    args: unknown
) {
    const parsed = ClassDeleteContentSchema.safeParse(args);
    if (!parsed.success) {
        throw new McpError(ErrorCode.InvalidRequest, `Invalid arguments: ${parsed.error}`);
    }

    try {
        const searchPath = getJavaRootPath(projectPath, parsed.data.sourceType, parsed.data.packagePath);
        const result = await searchInDirectory(searchPath, parsed.data.className, projectPath);

        if (!result.found || !result.filepath) {
            throw new McpError(ErrorCode.InvalidRequest, `Class file not found: ${parsed.data.className}`);
        }

        const edits = [{
            oldText: parsed.data.targetContent,
            newText: ''
        }];

        const fullPath = path.join(projectPath, result.filepath);
        return await applyFileEdits(fullPath, edits, parsed.data.dryRun);
    } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError(ErrorCode.InternalError,
            `Failed to delete content: ${error instanceof Error ? error.message : String(error)}`);
    }
}
