import {z} from "zod";
import {zodToJsonSchema} from "zod-to-json-schema";
import {ErrorCode, McpError, ToolSchema} from "@modelcontextprotocol/sdk/types.js";
import {ClassLocationSchema} from "./locateJavaClass.js";
import {getJavaRootPath, searchInDirectory} from "../utils/javaFileSearch.js";
import {applyFileEdits} from "../utils/fileEdits.js";
import path from "path";

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

const EditOperation = z.object({
    oldText: z.string().describe('Text to search for - must match exactly'),
    newText: z.string().describe('Text to replace with')
});

export const ClassReplaceContentSchema = ClassLocationSchema.extend({
    edits: z.array(EditOperation),
    dryRun: z.boolean().default(false).describe('Preview changes using git-style diff format')
});

export const classReplaceContentTool = {
    name: "class_replace_content",
    description: `Replace any content in a Java class file. This is a generic search and replace operation. Use this function when modifying 'implements' or 'extends' clauses. Examples:
- Add interface implementation:
  oldText: "class MyClass extends BaseClass"
  newText: "class MyClass extends BaseClass implements Interface"
- Update base class:
  oldText: "class MyClass extends OldBase"
  newText: "class MyClass extends NewBase"
- Replace method:
  oldText: "void process() { return input * 2; }"
  newText: "void process() { return input * factor; }"
`,
    inputSchema: zodToJsonSchema(ClassReplaceContentSchema) as ToolInput
};

export async function classReplaceContent(
    projectPath: string,
    args: unknown
) {
    const parsed = ClassReplaceContentSchema.safeParse(args);
    if (!parsed.success) {
        throw new McpError(ErrorCode.InvalidRequest, `Invalid arguments: ${parsed.error}`);
    }

    try {
        const searchPath = getJavaRootPath(projectPath, parsed.data.sourceType, parsed.data.packagePath);
        const result = await searchInDirectory(searchPath, parsed.data.className, projectPath);

        if (!result.found || !result.filepath) {
            throw new McpError(ErrorCode.InvalidRequest, `Class file not found: ${parsed.data.className}`);
        }

        const fullPath = path.join(projectPath, result.filepath);
        return await applyFileEdits(fullPath, parsed.data.edits, parsed.data.dryRun);
    } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError(ErrorCode.InternalError,
            `Failed to replace content: ${error instanceof Error ? error.message : String(error)}`);
    }
}
