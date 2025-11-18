import path from 'path';
import * as vscode from 'vscode';


let serverUrl = vscode.workspace.getConfiguration("codeSuggestions").get("serverUrl") 
              ?? "http://localhost:3000";

function isDebugModeEnabled(): boolean {
  // Always read the fresh config value when this function is called
  const config = vscode.workspace.getConfiguration("codeSuggestions");
  return config.get("debugMode", false); 
};
let isItDebugMode = isDebugModeEnabled();

vscode.workspace.onDidChangeConfiguration(e => {
  if (e.affectsConfiguration("codeSuggestions.serverUrl")) {
	const config = vscode.workspace.getConfiguration("codeSuggestions");
	serverUrl = config.get("serverUrl") ?? "http://localhost:3000";
    console.log("AI server URL changed", serverUrl);
  }

  if (e.affectsConfiguration("codeSuggestions.debugMode")) {
    const isItDebugMode = isDebugModeEnabled();
    console.log("AI debug mode changed to", isItDebugMode ? "ON (using MOCK data)" : "OFF (using LIVE server)");
  }
});
// interface FileContext {
//     path: string;
//     content: string;
// }
const FILE_SEPARATOR = "\n\n--- FILE: ";
const CURSOR_MARKER = "<|CURSOR|>"; // A unique token to mark the position
export function activate(context: vscode.ExtensionContext) {
  console.log('*** Extension "Code Suggestions" ACTIVATED! ***');
  const provider: vscode.InlineCompletionItemProvider = {
    async provideInlineCompletionItems(document, position, context, token) {
      
      // 1. Collect all file contents as before
      const currentFileContent = document.getText();
      const offset = document.offsetAt(position); 
      const line = document.lineAt(position);
      const prefix = line.text.substring(0, position.character);

      // We still need the file reading logic to collect context
      const currentDir = path.dirname(document.uri.fsPath);
      const contextContents: { path: string, content: string }[] = [];
      
      // Add the CURRENT file content
      contextContents.push({
          path: document.uri.fsPath,
          content: currentFileContent
      });

      // 2. Example: Add a related file (e.g., 'types.ts')
      // const relatedFilePath = path.join(currentDir, 'types.ts');
      // try {
      //     const relatedFileUri = vscode.Uri.file(relatedFilePath);
      //     const relatedFileBytes = await vscode.workspace.fs.readFile(relatedFileUri);
      //     const relatedFileContent = Buffer.from(relatedFileBytes).toString('utf8');
      //     contextContents.push({
      //         path: relatedFilePath,
      //         content: relatedFileContent
      //     });
      // } catch (e) {
      //     // File not found, ignore
      // }

      // 3. 💥 NEW: Combine all file contents into a single string (Plain Text)
      let combinedContext = '';
      let currentFileIndex = 0;

      for (const [index, file] of contextContents.entries()) {
          const content = file.content;
          
          // Use a special token to mark the insertion point in the PRIMARY file
          if (file.path === document.uri.fsPath) {
              // Insert the CURSOR_MARKER at the exact character offset
              const contentWithCursor = content.substring(0, offset) + CURSOR_MARKER + content.substring(offset);
              combinedContext += `${FILE_SEPARATOR}${file.path} ---\n${contentWithCursor}`;
              currentFileIndex = index; // Keep track of which file has the cursor
          } else {
              combinedContext += `${FILE_SEPARATOR}${file.path} ---\n${content}`;
          }
      }
      
      // 4. Send the single string to the suggestion function
      const suggestion = await getAISuggestion(combinedContext, prefix);

      if (!suggestion) return [];

      return [
        new vscode.InlineCompletionItem(
          suggestion,
          new vscode.Range(position, position)
        )
      ];
    }
  };
  // const provider: vscode.InlineCompletionItemProvider = {
  //   async provideInlineCompletionItems(document, position, context, token) {
  //     // 1. Get the ENTIRE file content
  //     const wholeFileContent = document.getText();
      
  //     // 2. Get the current cursor position as an index
  //     const offset = document.offsetAt(position); 

  //     // 3. Get the prefix (optional, but good for quick filtering)
  //     const line = document.lineAt(position);
  //     const prefix = line.text.substring(0, position.character);

  //     // Pass the whole file content and offset to the suggestion function
  //     console.log("Inline provider executed! Sending whole file.");
  //     const suggestion = await getAISuggestion(wholeFileContent, offset, prefix);

  //     if (!suggestion) return [];

  //     return [
  //       new vscode.InlineCompletionItem(
  //         suggestion,
  //         new vscode.Range(position, position)
  //       )
  //     ];
  //   }
  // };

  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { scheme: "file", language: "typescript" },
      provider
    )
  );
}


async function getAISuggestion(
  combinedContext: string, // Accepts the single, combined string
  prefix: string 
): Promise<string> {
  
  if (isItDebugMode) {
    console.log(`[DEBUG MODE] ${combinedContext}`);
    // Log the part of the context around the cursor for verification
    const cursorPos = combinedContext.indexOf(CURSOR_MARKER);
    const contextSample = combinedContext.substring(cursorPos - 20, cursorPos + 20).replace(/\n/g, ' ');
    console.log(`[DEBUG MODE] Context near cursor: ...${contextSample}...`);
    return 'suggestion is here (MOCK on single string)';
  }

  // PRODUCTION/LIVE PATH
  try {
    const serverUrl = vscode.workspace.getConfiguration("codeSuggestions").get("serverUrl") 
      ?? "http://localhost:3000";
      
    // 💥 NEW: Send the single text string to the server
    const requestBody = {
      context_text: combinedContext, // The combined plain text
      // The server will have to find the CURSOR_MARKER and extract the completion point
      language_id: vscode.window.activeTextEditor?.document.languageId, 
      prefix: prefix
    };

    const response = await fetch(`${serverUrl}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      console.error(`AI request failed: HTTP ${response.status}`);
      return "";
    }
    
    const data = await response.json() as any;
    return data.text ?? "";
  } catch (err) {
    console.error("AI request failed:", err);
    return "";
  }
}

export function deactivate() {}