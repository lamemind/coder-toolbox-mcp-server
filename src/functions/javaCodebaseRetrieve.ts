import {z} from "zod";
import {zodToJsonSchema} from "zod-to-json-schema";
import {ErrorCode, McpError, ToolSchema} from "@modelcontextprotocol/sdk/types.js";
import {ClassLocationSchema} from "./locateJavaClass.js";

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

export const JavaCodebaseRetrieveSchema = ClassLocationSchema.extend({
    package: z.string().min(1)
        .describe('Java package name from where to scan from java files'),
    scope: z.enum(['all', 'main', 'test'])
        .describe('Scope of the Java files to scan. "all" includes both main and test sources'),
    format: z.enum(['tree', 'complete'])
        .describe('Format of the codebase to retrieve. "tree" returns the codebase as a tree structure, "complete" returns the same tree structure but with the content of each file')
});

export const JavaCodebaseRetrieveTool = {
    name: "java_codebase_retrieve",
    description: `Retrieve the codebase of a Java project`,
    inputSchema: zodToJsonSchema(JavaCodebaseRetrieveSchema) as ToolInput
};

interface TreeEntry {
    name: string;
    type: 'file' | 'directory';
    children?: TreeEntry[];
    path: string;
    content?: string;
    package?: string;
}

export async function javaCodebaseRetrieve(
    projectPath: string,
    args: unknown
) {
    const parsed = JavaCodebaseRetrieveSchema.safeParse(args);
    if (!parsed.success) {
        throw new McpError(ErrorCode.InvalidRequest, `Invalid arguments: ${parsed.error}`);
    }

    try {

        // TODO
        throw new Error('Not implemented');

    } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError(ErrorCode.InternalError,
            `Failed to add content: ${error instanceof Error ? error.message : String(error)}`);
    }
}
