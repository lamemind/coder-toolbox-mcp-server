import {z} from "zod";
import {zodToJsonSchema} from "zod-to-json-schema";
import {ErrorCode, McpError, ToolSchema} from "@modelcontextprotocol/sdk/types.js";
import {ClassLocationSchema} from "./locateJavaClass.js";
import {getJavaRootPath, searchInDirectory} from "../utils/javaFileSearch.js";
import path from "path";
import fs from "fs/promises";

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

export const ClassAddContentSchema = ClassLocationSchema.extend({
    content: z.string().min(1)
        .describe('The content to add to the class file'),
    injectionPoint: z.enum(['import', 'annotation', 'class_content'])
        .describe('Where to inject the content (after imports, before class declaration, or before closing brace)')
});

export const classAddContentTool = {
    name: "class_add_content",
    description: `Add content to a Java class file at a specific injection point. Examples:
- Add new import (injectionPoint: 'import'):
  content: "import java.util.ArrayList;"
- Add class annotation (injectionPoint: 'annotation'): 
  content: "@Service\n@Transactional"
- Add new method (injectionPoint: 'class_content'):
  content: "public void calculate() { ... }"
`,
    inputSchema: zodToJsonSchema(ClassAddContentSchema) as ToolInput
};

async function findInjectionPoint(content: string, point: 'import' | 'annotation' | 'class_content'): Promise<number> {
    if (point === 'import') {
        const lastImport = content.match(/^import\s+[^;]+;/gm);
        if (!lastImport) {
            const packageEnd = content.indexOf(';');
            return packageEnd !== -1 ? packageEnd + 1 : 0;
        }
        const lastImportIndex = content.lastIndexOf(lastImport[lastImport.length - 1]);
        return lastImportIndex + lastImport[lastImport.length - 1].length;
    }

    if (point === 'annotation') {
        const classMatch = content.match(/\bclass\s+[A-Za-z_][A-Za-z0-9_]*/);
        if (!classMatch || !classMatch.index) {
            throw new Error("Could not find class declaration");
        }
        return classMatch.index;
    }

    if (point === 'class_content') {
        const lastBrace = content.lastIndexOf('}');
        if (lastBrace === -1) {
            throw new Error("Could not find class closing brace");
        }
        return lastBrace;
    }

    throw new Error("Invalid injection point");
}

export async function classAddContent(
    projectPath: string,
    args: unknown
) {
    const parsed = ClassAddContentSchema.safeParse(args);
    if (!parsed.success) {
        throw new McpError(ErrorCode.InvalidRequest, `Invalid arguments: ${parsed.error}`);
    }

    try {
        const searchPath = getJavaRootPath(projectPath, parsed.data.sourceType, parsed.data.packagePath);
        const result = await searchInDirectory(searchPath, parsed.data.className, projectPath);

        if (!result.found || !result.filepath || !result.content) {
            throw new McpError(ErrorCode.InvalidRequest, `Class file not found: ${parsed.data.className}`);
        }

        const fileContent = result.content;
        const insertPosition = await findInjectionPoint(fileContent, parsed.data.injectionPoint);

        const formattedContent = parsed.data.injectionPoint === 'class_content'
            ? '\n\n' + parsed.data.content + '\n'
            : '\n' + parsed.data.content + '\n\n';

        const newContent = fileContent.slice(0, insertPosition) +
            formattedContent +
            fileContent.slice(insertPosition);

        const fullPath = path.join(projectPath, result.filepath);
        await fs.writeFile(fullPath, newContent, 'utf-8');

        return {
            success: true,
            filepath: result.filepath
        };
    } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError(ErrorCode.InternalError,
            `Failed to add content: ${error instanceof Error ? error.message : String(error)}`);
    }
}
