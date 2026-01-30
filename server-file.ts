import { Request, Response } from "express";

// --- ⚙️ FIM Configuration Constants (UPDATED FOR QWEN) ---

// 🚀 Qwen2.5 FIM Tokens (From your shared template)
const FIM_PREFIX_TOKEN = '<|fim_prefix|>';
const FIM_SUFFIX_TOKEN = '<|fim_suffix|>';
const FIM_MIDDLE_TOKEN = '<|fim_middle|>'; 
const CURSOR_MARKER = "<|CURSOR|>";
const FILE_SEPARATOR = "\n\n--- FILE: "; 

// 🚀 Qwen Instruction Tokens (Image Instruction Markers)
const QWEN_IM_START = '<|im_start|>';
const QWEN_IM_END = '<|im_end|>';
const SYSTEM_INSTRUCTION = 'You are a concise code completion engine. Only output code, nothing else.'; 

// 🚨 Context Truncation Limit
const CONTEXT_LIMIT = 2000; // Increased context limit for Qwen (use a larger value)

// 🚨 Ollama API Constants
const LLAMA_SERVER_URL = "http://localhost:11434/api/generate"; 
const LLAMA_MODEL_NAME = "dagbs/qwen2.5-coder-7b-instruct-abliterated:q4_k_l"; // Updated model name

let isProcessing = false; 

// --- 💾 Interface for Request Body ---

interface CompletionRequest {
    context_text : string; 
    language_id?: string;
    prefix?: string;      
}

// -------------------------------------------------------------------
// 🌍 Express Controller (API Route)
// -------------------------------------------------------------------

export const completeController = async (req: Request<{}, {}, CompletionRequest>, res: Response) => {
    const { context_text } = req.body;
    // Clean up excessive whitespace/markers, if necessary.
    const context_text_updated = context_text.replace('  ', '').trim();
    
    const cursorIndex = context_text_updated.indexOf(CURSOR_MARKER);
    
    if (cursorIndex === -1) {
        console.error("Error: CURSOR_MARKER not found.");
        return res.status(400).json({ error: "Cursor marker missing." });
    }

    let prefixContent = context_text_updated.substring(0, cursorIndex);
    let suffixContent = context_text_updated.substring(cursorIndex + CURSOR_MARKER.length);

    // 🔑 CONTEXT TRUNCATION: Limit prefix and suffix to a total of CONTEXT_LIMIT characters
    // The previous logic truncated to 30 characters total, which is too aggressive. 
    // This logic ensures we use the maximum available context up to the limit.
    const combinedLength = prefixContent.length + suffixContent.length;
    
    if (combinedLength > CONTEXT_LIMIT) {
        const excess = combinedLength - CONTEXT_LIMIT;
        // Prioritize keeping the suffix for FIM, but trim both proportionally
        const trimPrefixBy = Math.min(Math.floor(excess * 0.7), prefixContent.length);
        const trimSuffixBy = Math.min(excess - trimPrefixBy, suffixContent.length);

        // Keep the end of the prefix (near the cursor)
        prefixContent = prefixContent.substring(trimPrefixBy);
        // Keep the start of the suffix (near the cursor)
        suffixContent = suffixContent.substring(0, suffixContent.length - trimSuffixBy);
    }
    
    // 2. CONSTRUCT THE FIM PROMPT
    // FIM Structure: <|fim_prefix|>PREFIX<|fim_suffix|>SUFFIX<|fim_middle|>
    const fimStructure = `${FIM_PREFIX_TOKEN}${prefixContent}${FIM_SUFFIX_TOKEN}${suffixContent}${FIM_MIDDLE_TOKEN}`;
    
    // 3. CONSTRUCT THE QWEN INSTRUCTION TEMPLATE
    /* Template required structure:
    <|im_start|>system
    System instruction<|im_end|>
    <|im_start|>user
    FIM_CONTEXT<|im_end|>
    <|im_start|>assistant
    */
    const fimPrompt = 
        `${QWEN_IM_START}system\n${SYSTEM_INSTRUCTION}${QWEN_IM_END}\n` + 
        `${QWEN_IM_START}user\n${fimStructure}${QWEN_IM_END}\n` +
        `${QWEN_IM_START}assistant\n`; // End with assistant tag for model to begin generation

    console.log(`Context length: ${fimPrompt.length}`);
    console.log(`Prefix used: "${prefixContent}", Suffix used: "${suffixContent}"`);
    
    // 4. Call the AI Model
    try {
        if (isProcessing) {
            return res.json({ text: 'in process' });
        }
        
        const rawSuggestion = await callFimModelAPI(fimPrompt); 

        // 5. Post-process and Send Response
        // Pass the full original context_text_updated to the post-processor for better cleanup
        const finalSuggestion = postProcessSuggestion(rawSuggestion, suffixContent, fimPrompt);
        res.json({ text: finalSuggestion });
        
    } catch (error) {
        console.error("AI Model generation failed:", error);
        res.status(500).json({ error: "Failed to generate AI suggestion." });
    }
};

// -------------------------------------------------------------------
// 🧹 Post-Processing Helper (Updated Tokens)
// -------------------------------------------------------------------

/**
 * Cleans the raw model suggestion by stripping repetition, stop tokens, and suffix overlap.
 */
function postProcessSuggestion(rawSuggestion: string, suffixContent: string, fimPrompt: string): string {
    let cleanedSuggestion = rawSuggestion;
    
    // 1. Aggressive Prompt Stripping 
    const promptIndex = cleanedSuggestion.lastIndexOf(fimPrompt);
    if (promptIndex !== -1) {
        cleanedSuggestion = cleanedSuggestion.substring(promptIndex + fimPrompt.length);
    } 
    
    // 2. Strip End Tokens and Separators
    // Updated stop tokens list for Qwen
    const stopTokens = [
        '<|fim_prefix|>', '<|fim_suffix|>', '<|fim_middle|>', 
        '<|im_start|>', '<|im_end|>',       
        '</tool_response>', // Add tool/chat tags as stop tokens
        FILE_SEPARATOR             
    ];
    
    for (const token of stopTokens) {
        const index = cleanedSuggestion.indexOf(token);
        if (index !== -1) {
            cleanedSuggestion = cleanedSuggestion.substring(0, index).trimEnd();
        }
    }
    
    // 3. Find and trim any overlap with the start of the original suffix
    const firstSuffixCodeLine = suffixContent.split('\n')[0].trim();
    if (firstSuffixCodeLine.length > 0) {
        const overlapIndex = cleanedSuggestion.indexOf(firstSuffixCodeLine);

        if (overlapIndex > 0) { 
             cleanedSuggestion = cleanedSuggestion.substring(0, overlapIndex).trimEnd();
        }
    }
    
    return cleanedSuggestion.trim();
}

// -------------------------------------------------------------------
// 💻 AI Model API Client (Updated Stop Tokens)
// -------------------------------------------------------------------
function stripCodeBlock(codeBlock: string): string {
    const regex = /^\s*```[a-zA-Z0-9]*\n(.*)\n```\s*$/s;

    // Use replace with a capture group ($1) to keep only the code content
    const match = codeBlock.match(regex);
    
    if (match && match[1]) {
        // Return the captured group (the clean code), removing leading/trailing whitespace
        return match[1].trim();
    }
    
    // If no full code block match is found, return the original string trimmed
    return codeBlock.trim();
}
async function callFimModelAPI(fimPrompt: string): Promise<string> {
    console.log(fimPrompt);
    const requestBody = {
        model: LLAMA_MODEL_NAME, 
        prompt: fimPrompt,
        stream: false, 
        options: {
            temperature: 0.2, 
            num_ctx: 4096,    
            repetition_penalty: 1.15,
            num_predict: 1000,
            // Updated stop tokens list for Qwen
            stop: [
                '<|fim_prefix|>', '<|fim_suffix|>', '<|fim_middle|>', 
                '<|im_start|>', '<|im_end|>',
                '</tool_response>',
                FILE_SEPARATOR   
            ],
        },
    };
    isProcessing = true;
    
    try {
        const response = await fetch(LLAMA_SERVER_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody)
        });
        
        if (!response.ok) {
            throw new Error(`LLAMA API request failed: HTTP ${response.status}`);
        }
        
        const data = await response.json() as any;
        console.log(data.response);
        return stripCodeBlock(data.response) ?? "";

    } catch (error) {
        throw error;
    } finally {
        isProcessing = false;
    }
}
