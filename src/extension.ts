import path from 'path';
import * as vscode from 'vscode';

// --- Configuration Variables ---

let serverUrl = vscode.workspace.getConfiguration("codeSuggestions").get("serverUrl") 
              ?? "http://localhost:3000";

function isDebugModeEnabled(): boolean {
  // Always read the fresh config value when this function is called
  const config = vscode.workspace.getConfiguration("codeSuggestions");
  return config.get("debugMode", false); 
};
let isItDebugMode = isDebugModeEnabled();

// --- Configuration Change Listener ---

vscode.workspace.onDidChangeConfiguration(e => {
  if (e.affectsConfiguration("codeSuggestions.serverUrl")) {
    const config = vscode.workspace.getConfiguration("codeSuggestions");
    serverUrl = config.get("serverUrl") ?? "http://localhost:3000";
    console.log("AI server URL changed", serverUrl);
  }

  if (e.affectsConfiguration("codeSuggestions.debugMode")) {
    // Re-fetch the current state of debugMode
    isItDebugMode = isDebugModeEnabled(); 
    console.log("AI debug mode changed to", isItDebugMode ? "ON (using MOCK data)" : "OFF (using LIVE server)");
  }
});

// --- Constants ---

const FILE_SEPARATOR = "\n\n--- FILE: ";
const CURSOR_MARKER = "<|CURSOR|>"; // A unique token to mark the position

// --- Activate Function ---

export function activate(context: vscode.ExtensionContext) {
  console.log('*** Extension "Code Suggestions" ACTIVATED! ***');

  // 1. Define the Inline Completion Provider
  const provider: vscode.InlineCompletionItemProvider = {
    async provideInlineCompletionItems(document, position, context, token) {
      
      // 💥 CRITICAL CHECK: Only provide suggestions if manually invoked (by the command).
      // If the triggerKind is 'Automatic', return an empty array to disable typing-based suggestions.
      if (context.triggerKind !== vscode.InlineCompletionTriggerKind.Invoke) {
          return []; 
      }
      
      // 1. Collect all file contents
      const currentFileContent = document.getText();
      const offset = document.offsetAt(position); 
      const line = document.lineAt(position);
      const prefix = line.text.substring(0, position.character);

      const contextContents: { path: string, content: string }[] = [];
      contextContents.push({ path: document.uri.fsPath, content: currentFileContent });

      // 2. Combine all file contents into a single string (Plain Text)
      let combinedContext = '';
      for (const file of contextContents) {
          const content = file.content;
          
          if (file.path === document.uri.fsPath) {
              const contentWithCursor = content.substring(0, offset) + CURSOR_MARKER + content.substring(offset);
              combinedContext += `${FILE_SEPARATOR}${file.path} ---\n${contentWithCursor}`;
          } else {
              combinedContext += `${FILE_SEPARATOR}${file.path} ---\n${content}`;
          }
      }
      
      // 3. Send the single string to the suggestion function
      const suggestion = await getAISuggestion(combinedContext, prefix);

      if (!suggestion) return [];

      // 4. Return the result as a ghost text item
      return [
        new vscode.InlineCompletionItem(
          suggestion,
          new vscode.Range(position, position)
        )
      ];
    }
  };

  // 2. Register the automatic provider
  // It is now conditional (see the check inside provideInlineCompletionItems)
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      // Ensure this matches the languages you want to support
      { scheme: "file", language: "typescript" }, 
      provider
    )
  );

  // 3. Register a command that manually triggers the provider
  const disposableCommand = vscode.commands.registerCommand(
    'codeSuggestions.triggerSuggestion', // Command ID that must match package.json
    () => {
        // Official VS Code command to manually ask the active InlineCompletionItemProvider to run.
        vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    }
  );
  
  context.subscriptions.push(disposableCommand);
  
  // 4. Register the context menu command (to fix the previous error, if applicable)
  const removeContextFileDisposable = vscode.commands.registerCommand(
    'codeSuggestions.removeContextFile', 
    (fileUri: vscode.Uri) => {
      // Placeholder implementation for the context menu item
      if (fileUri) {
          vscode.window.showInformationMessage(`Context file removed: ${fileUri.fsPath}`);
      } else {
          vscode.window.showInformationMessage('Remove context file command triggered.');
      }
    }
  );
  context.subscriptions.push(removeContextFileDisposable);
}

// --- AI Suggestion Function ---

async function getAISuggestion(
  combinedContext: string, // Accepts the single, combined string
  prefix: string 
): Promise<string> {
  
  if (isItDebugMode) {
    console.log(`[DEBUG MODE] ${combinedContext}`);
    const cursorPos = combinedContext.indexOf(CURSOR_MARKER);
    const contextSample = combinedContext.substring(cursorPos - 20, cursorPos + 20).replace(/\n/g, ' ');
    console.log(`[DEBUG MODE] Context near cursor: ...${contextSample}...`);
    return 'suggestion is here (MOCK on single string)';
  }

  // PRODUCTION/LIVE PATH
  try {
    // Use the most recent configuration value
    const currentServerUrl = vscode.workspace.getConfiguration("codeSuggestions").get("serverUrl") 
      ?? "http://localhost:3000";
      
    const requestBody = {
      context_text: combinedContext,
      language_id: vscode.window.activeTextEditor?.document.languageId, 
      prefix: prefix
    };

    const response = await fetch(`${currentServerUrl}/complete`, {
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

// --- Deactivate Function ---

export function deactivate() {}