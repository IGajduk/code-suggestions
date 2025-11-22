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
function findDeepestSymbol(
    symbols: vscode.DocumentSymbol[], 
    position: vscode.Position
): vscode.DocumentSymbol | undefined {
    
    for (const symbol of symbols) {
        if (symbol.range.contains(position)) {
            // If this symbol has children (e.g., Class has Methods), look deeper
            if (symbol.children.length > 0) {
                const child = findDeepestSymbol(symbol.children, position);
                if (child) {
                    return child;
                }
            }
            // If no children contain the cursor, this symbol is the deepest one
            return symbol;
        }
    }
    return undefined;
}
  // 1. Define the Inline Completion Provider
  const provider: vscode.InlineCompletionItemProvider = {
   async provideInlineCompletionItems(document, position, context, token) {
        if (context.triggerKind !== vscode.InlineCompletionTriggerKind.Invoke) {
            return [];
        }

        const fullText = document.getText();
        const offset = document.offsetAt(position);
        const line = document.lineAt(position);
        const prefix = line.text.substring(0, position.character);

        let promptContext = "";

        // --- 1. GRANULAR: Extract Imports ---
        // Simple regex to grab all import lines from the top of the file
        // This ensures the AI knows your types even if we hide other code.
        const importLines = fullText.match(/^import .*?;/gm) || [];
        const importsText = importLines.join('\n');

        // --- 2. GRANULAR: Find Active Scope ---
        try {
            // Ask VS Code for the file structure (AST)
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                document.uri
            );

            const activeSymbol = symbols ? findDeepestSymbol(symbols, position) : undefined;

            if (activeSymbol) {
                // If we found a function/method, only send that!
                // We grab the text strictly within that symbol's range
                const symbolText = document.getText(activeSymbol.range);
                
                // Calculate where the cursor is RELATIVE to the start of this symbol
                const symbolStartOffset = document.offsetAt(activeSymbol.range.start);
                const relativeCursorOffset = offset - symbolStartOffset;

                // Insert the cursor marker inside the symbol text
                const textWithCursor = 
                    symbolText.substring(0, relativeCursorOffset) + 
                    CURSOR_MARKER + 
                    symbolText.substring(relativeCursorOffset);

                console.log(`[AI] Focused on symbol: ${activeSymbol.name}`);
                
                // Combine: Imports + The specific function we are working on
                promptContext = `${importsText}\n\n// ... (irrelevant code hidden) ...\n\n${textWithCursor}`;
            
            } else {
                // Fallback: If we are in global scope (not in a function), use the Sliding Window approach
                // (You can reuse the sliding window logic here as a backup)
                const start = Math.max(0, offset - 1000);
                const end = Math.min(fullText.length, offset + 1000);
                const slice = fullText.substring(start, end);
                promptContext = slice.substring(0, offset - start) + CURSOR_MARKER + slice.substring(offset - start);
            }

        } catch (err) {
            console.error("Error getting symbols:", err);
            // Fallback to simple text if symbol provider fails
            promptContext = fullText; 
        }

        // --- 3. Formatting ---
        const combinedContext = `${FILE_SEPARATOR}${document.uri.fsPath} ---\n${promptContext}`;

        // --- 4. Send Request ---
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