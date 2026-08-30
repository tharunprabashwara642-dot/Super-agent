/**
 * LIVE ACTIVITY FIX for File Search
 * 
 * This patch improves how the bot reports on file search operations by:
 * 1. Wrapping all console.log() calls in file discovery with live_activity.step()
 * 2. Adding sub-agent communication visibility
 * 3. Using proper async/await with live status updates
 * 4. Removing spam console logs
 * 
 * Apply this by finding where file search happens in your index.js
 * and replacing those sections with the patterns shown below.
 */

// ============================================================
// PATTERN 1: Replace all file discovery logic
// ============================================================
// SEARCH FOR THIS in index.js (around line 1000-1500):
// const startFileSearch = async (query) => {
// const searchResults = []
// for (const file of allFiles)

// REPLACE WITH THIS:
const startFileSearch = async (query, chatId) => {
  const live = require('./live_activity.js');
  
  try {
    // Start live activity instead of console.log
    await live.start('ගොනු සොයනවා', { 
      chatId,
      presentation: {
        title: '🔍 ගොනු සොයනවා',
        compact: false,
        showTimer: true
      }
    });

    const searchResults = [];
    let totalFiles = 0;
    let matchedFiles = 0;

    // Step 1: Scan file system
    await live.step('ගොනු පද්ධතිය පරිලෝකනය කරනවා', 'running', { chatId });
    totalFiles = await countAllFiles(); // Your existing function
    await live.step(`${totalFiles} ගොනු කුඩුරු ගණනය කරන ලදි`, 'done', { chatId });

    // Step 2: Initialize search
    await live.step('සෙවුම් උපකරණ ශුරු කරනවා', 'running', { chatId });
    const allFiles = await getAllFiles(); // Your existing function
    await live.step('සෙවුම් එක සකස් කරන ලදි', 'done', { chatId });

    // Step 3: Search through files
    await live.step(`"${query}" සඳහා සොයනවා`, 'running', { chatId });
    
    for (let i = 0; i < allFiles.length; i++) {
      const file = allFiles[i];
      
      // Update progress every 10 files
      if (i % 10 === 0 && i > 0) {
        await live.step(`${matchedFiles} ගොනු ගැහැණුවා (${i}/${totalFiles} පරිලෝකනය කරන ලදි)`, 'running', { chatId });
      }

      if (file.name.includes(query) || file.content.includes(query)) {
        matchedFiles++;
        searchResults.push(file);
      }
    }
    
    await live.step(`සෙවුම සම්පූර්ණ - ${matchedFiles} ගොනු හමුවිය`, 'done', { chatId });

    // Step 4: Sub-agent analysis (if you have this)
    if (searchResults.length > 0) {
      await live.step('උප-ඒජෙන්සිවරු විශ්ලේෂණ කරනවා', 'running', { chatId });
      
      // Your sub-agent logic here
      // Instead of console.log, use:
      // await live.step('Sub-agent X analyzed results', 'running', { chatId });
      
      await live.step('උප-ඒජෙන්සිවරු විශ්ලේෂණ ඉවරයි', 'done', { chatId });
    }

    await live.finish(`${matchedFiles} ගොනු සොයා ගත්ත`, { chatId });
    
    return searchResults;

  } catch (error) {
    await live.fail(`සෙවුම අසාර්ථක: ${error.message}`, { chatId });
    throw error;
  }
};


// ============================================================
// PATTERN 2: Hide console logs, use live_activity for status
// ============================================================
// FIND ALL THESE PATTERNS AND REPLACE:

// OLD:
// console.log(`🔌 MCP connector connected: ${row.label}`);

// NEW:
// await live.step(`🔌 MCP connector connected: ${row.label}`, 'done', { chatId });
// (Store live_activity instance at the top of your async function)


// ============================================================
// PATTERN 3: Sub-agent communication wrapper
// ============================================================
// If sub-agents send messages internally, wrap them like this:

const wrapSubAgentCommunication = async (agentName, action, details, live, chatId) => {
  // Instead of silent internal logging, show it in live activity
  await live.step(`${agentName} → ${action}: ${details}`, 'running', { chatId });
  
  // Do the actual work
  // Then mark as done:
  await live.step(`${agentName} → ${action}: සම්පූර්ණ`, 'done', { chatId });
};


// ============================================================
// PATTERN 4: Replace all PDF generation calls
// ============================================================
// OLD (from your images):
// console.log('Creating PDF for exam...');
// const pdf = createPDF(...);
// console.log('PDF created');

// NEW:
// await live.step('පরීක්ෂණ PDF සම්පූර්ණ කරනවා', 'running', { chatId });
// const pdf = createPDF(...);
// await live.step('PDF සිදු කරන ලදි', 'done', { chatId });


// ============================================================
// IMPLEMENTATION CHECKLIST
// ============================================================
// 1. Find every place you send a request to the bot (in index.js)
// 2. Extract the chatId from that context
// 3. Create a live_activity instance with:
//    await live.start('task name', { chatId });
// 4. Replace all console.log() calls with live.step()
// 5. Call live.finish() when done
// 6. Call live.fail() if an error occurs

// Example in your handler:
/*
bot.onText(/\/search (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = match[1];
  
  try {
    const results = await startFileSearch(query, chatId);
    await live.finish(`සෙවුම සම්පූර්ණ - ${results.length} ගොනු`);
  } catch (e) {
    await live.fail(`ගෝෂ: ${e.message}`);
  }
});
*/

module.exports = {
  startFileSearch,
  wrapSubAgentCommunication,
};
