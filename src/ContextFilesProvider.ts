import * as vscode from 'vscode';
import * as path from 'path';

// --- Helper Functions to manage Settings Array ---

function getContextFiles(): string[] {
    const config = vscode.workspace.getConfiguration("codeSuggestions");
    return config.get<string[]>("contextFiles", []);
}

async function setContextFiles(files: string[]) {
    const config = vscode.workspace.getConfiguration("codeSuggestions");
    await config.update("contextFiles", files, vscode.ConfigurationTarget.Workspace);
}

// --- Tree Item Class ---

class ContextFileItem extends vscode.TreeItem {
  constructor(public readonly label: string, public readonly fullPath: string) {
    super(path.basename(label), vscode.TreeItemCollapsibleState.None);
    this.description = path.dirname(label); // Show the directory path
    this.tooltip = fullPath;
    this.iconPath = vscode.ThemeIcon.File;
    this.contextValue = 'contextFileItem'; // Used for the context menu
  }
}

// --- View Provider Class ---

export class ContextFilesProvider implements vscode.TreeDataProvider<ContextFileItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<ContextFileItem | undefined | void> = new vscode.EventEmitter<ContextFileItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<ContextFileItem | undefined | void> = this._onDidChangeTreeData.event;

  constructor() {
    // Listen for changes in our settings to refresh the view
    vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration("codeSuggestions.contextFiles")) {
            this.refresh();
        }
    });
  }

  // Reloads the view
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ContextFileItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ContextFileItem): Thenable<ContextFileItem[]> {
    if (element) {
      return Promise.resolve([]);
    }
    
    // Read the file paths from settings
    const files = getContextFiles();
    
    // Convert relative paths (from settings) to TreeItems for display
    const items = files.map(filePath => new ContextFileItem(filePath, filePath));
    return Promise.resolve(items);
  }

  // --- DRAG AND DROP IMPLEMENTATION ---
  
  // VS Code requires the extension to state what kinds of data it accepts
  getDropMimeTypes(): readonly string[] {
    // VS Code uses 'text/uri-list' when dragging files from the Explorer
    return ['text/uri-list']; 
  }

  // This function handles the actual drop event
  async handleDrag(dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
    const item = dataTransfer.get('text/uri-list');
    if (item) {
      const uriList = await item.asString();
      const newFiles: string[] = [];
      
      // Parse the URI list (may contain multiple files dropped)
      uriList.split('\n').forEach(line => {
        try {
          // Convert the URI string back into a URI object
          const uri = vscode.Uri.parse(line.trim());
          
          // To store the path in settings, we need it relative to the workspace root
          const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
          if (workspaceFolder) {
            // Store the path relative to the workspace folder path (more portable)
            const relativePath = path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
            newFiles.push(relativePath);
          } else {
            // For files outside the workspace, we store the full path
            newFiles.push(uri.fsPath);
          }
        } catch (e) {
          console.error("Failed to parse dropped URI:", line);
        }
      });

      // Get current list, append new files, and update settings
      const currentFiles = getContextFiles();
      const updatedFiles = Array.from(new Set([...currentFiles, ...newFiles])); // Use Set to ensure unique paths
      
      await setContextFiles(updatedFiles);
      this.refresh();
    }
  }
}