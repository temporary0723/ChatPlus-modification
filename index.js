// =========================
// 1. Imports & Constants
// =========================
import { addJQueryHighlight } from './jquery-highlight.js';
import { getGroupAvatar, getGroupBlock, getGroupPastChats, groups, select_group_chats } from '../../../group-chats.js';
import { getPastCharacterChats, selectCharacterById, renameGroupOrCharacterChat, event_types, setActiveGroup } from '../../../../script.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { timestampToMoment } from '../../../utils.js';
import { deleteAttachment } from '../../../chats.js';
import { extension_settings } from '../../../extensions.js';
import { t } from '../../../i18n.js';

const {
    getCurrentChatId,
    getRequestHeaders,
    openGroupChat,
    openCharacterChat,
    getThumbnailUrl,
    extensionSettings,
    saveSettingsDebounced,
    eventSource
} = SillyTavern.getContext();
const MODULE_NAME = 'chatsPlus';
const defaultSettings = {
    pinnedChats: [],
    characterChatFolders: {}, // 캐릭터별 폴더 시스템
    analysisMode: '1st-person', // '1st-person' or '3rd-person'
    analysisPrompt1stPerson: '', // Will be set with default later
    analysisPrompt3rdPerson: '', // Will be set with default later
    includeCharacterDescription: true, // Include character description in analysis
};
if (!('folders' in defaultSettings)) defaultSettings.folders = [];
if (!('chatFolders' in defaultSettings)) defaultSettings.chatFolders = {};
if (!('characterChatFolders' in defaultSettings)) defaultSettings.characterChatFolders = {};
const MAX_RECENT_CHATS = 100;

// =========================
// 2. Settings & State Management
// =========================
let activateTab = null;
let refreshFoldersTab = null; // will be defined after function definitions
let recentChatsTabContainer = null;
let isRefreshingFoldersTab = false; // Flag to prevent concurrent refreshes

/**
 * Get the extension settings object, initializing if necessary.
 * @returns {Object} The settings object for this extension.
 */
function getSettings() {
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key in defaultSettings) {
        if (extensionSettings[MODULE_NAME][key] === undefined) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

/**
 * Get the list of pinned chats from settings.
 * @returns {Array} Array of pinned chat objects.
 */
function getPinnedChats() {
    try { return getSettings().pinnedChats || []; } catch { return []; }
}

/**
 * Set the list of pinned chats in settings.
 * @param {Array} pinned - Array of pinned chat objects.
 */
function setPinnedChats(pinned) {
    getSettings().pinnedChats = pinned;
    saveSettingsDebounced();
}

/**
 * Check if a chat is pinned.
 * @param {Object} chat - Chat object.
 * @returns {boolean} True if pinned, false otherwise.
 */
function isChatPinned(chat) {
    const pinned = getPinnedChats();
    return pinned.some(x => x.characterId === chat.characterId && x.file_name === chat.file_name);
}

/**
 * Toggle the pinned state of a chat.
 * @param {Object} chat - Chat object.
 */
function togglePinChat(chat) {
    let pinned = getPinnedChats();
    const idx = pinned.findIndex(x => x.characterId === chat.characterId && x.file_name === chat.file_name);
    if (idx === -1) pinned.push({ characterId: chat.characterId, file_name: chat.file_name });
    else pinned.splice(idx, 1);
    setPinnedChats(pinned);
}

/**
 * Get the list of folders from settings.
 * @returns {Array} Array of folder objects.
 */
function getFolders() {
    try {
        const folders = getSettings().folders || [];
        // Ensure all folders have a parent property (for backward compatibility)
        for (const folder of folders) {
            if (!('parent' in folder)) folder.parent = null;
        }
        return folders;
    } catch { return []; }
}

/**
 * Set the list of folders in settings.
 * @param {Array} folders - Array of folder objects.
 */
function setFolders(folders) {
    getSettings().folders = folders;
    saveSettingsDebounced();
}

/**
 * Add a new folder with the given name and optional parent.
 * @param {string} name - Name of the new folder.
 * @param {string|null} parent - Parent folder ID, or null for root.
 */
function addFolder(name, parent = null) {
    const folders = getFolders();
    const id = 'folder_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
    folders.push({ id, name, parent });
    setFolders(folders);
}

/**
 * Remove a folder by its ID.
 * @param {string} id - Folder ID.
 */
function removeFolder(id) {
    let folders = getFolders();
    folders = folders.filter(f => f.id !== id);
    setFolders(folders);
}

/**
 * Get the chat-to-folders mapping from settings.
 * @returns {Object} Map of chat key to array of folder IDs.
 */
function getChatFoldersMap() {
    try { return getSettings().chatFolders || {}; } catch { return {}; }
}

/**
 * Set the chat-to-folders mapping in settings.
 * @param {Object} map - Map of chat key to array of folder IDs.
 */
function setChatFoldersMap(map) {
    getSettings().chatFolders = map;
    saveSettingsDebounced();
}

/**
 * Assign a chat to a folder.
 * @param {Object} chat - Chat object.
 * @param {string} folderId - Folder ID.
 */
function assignChatToFolder(chat, folderId) {
    const map = getChatFoldersMap();
    const key = chat.characterId + ':' + chat.file_name;
    if (!Array.isArray(map[key])) map[key] = [];
    if (!map[key].includes(folderId)) map[key].push(folderId);
    setChatFoldersMap(map);
}

/**
 * Remove a chat from a folder.
 * @param {Object} chat - Chat object.
 * @param {string} folderId - Folder ID.
 */
function removeChatFromFolder(chat, folderId) {
    const map = getChatFoldersMap();
    const key = chat.characterId + ':' + chat.file_name;
    if (Array.isArray(map[key])) {
        map[key] = map[key].filter(id => id !== folderId);
        if (map[key].length === 0) delete map[key];
    }
    setChatFoldersMap(map);
}

/**
 * Get all folder IDs assigned to a chat.
 * @param {Object} chat - Chat object.
 * @returns {Array} Array of folder IDs.
 */
function getChatFolderIds(chat) {
    const map = getChatFoldersMap();
    const key = chat.characterId + ':' + chat.file_name;
    return Array.isArray(map[key]) ? map[key] : [];
}

/**
 * Get the first folder ID assigned to a chat (legacy compatibility).
 * @param {Object} chat - Chat object.
 * @returns {string|null} Folder ID or null.
 */
function getChatFolderId(chat) {
    const ids = getChatFolderIds(chat);
    return ids.length > 0 ? ids[0] : null;
}

// =========================
// 2.5. Character-specific Folder Functions
// =========================
/**
 * Get character-specific folders for a given character.
 * @param {string} characterId - Character ID.
 * @returns {Array} Array of folder objects for this character.
 */
function getCharacterFolders(characterId) {
    try {
        const settings = getSettings();
        if (!settings.characterChatFolders) {
            settings.characterChatFolders = {};
            saveSettingsDebounced();
        }
        if (!settings.characterChatFolders[characterId]) {
            settings.characterChatFolders[characterId] = { folders: [], chatFolders: {} };
            saveSettingsDebounced();
        }
        const folders = settings.characterChatFolders[characterId].folders || [];
        // Ensure all folders have a parent property (for backward compatibility)
        for (const folder of folders) {
            if (!('parent' in folder)) folder.parent = null;
        }
        return folders;
    } catch { return []; }
}

/**
 * Set character-specific folders.
 * @param {string} characterId - Character ID.
 * @param {Array} folders - Array of folder objects.
 */
function setCharacterFolders(characterId, folders) {
    const settings = getSettings();
    if (!settings.characterChatFolders) settings.characterChatFolders = {};
    if (!settings.characterChatFolders[characterId]) settings.characterChatFolders[characterId] = { folders: [], chatFolders: {} };
    settings.characterChatFolders[characterId].folders = folders;
    saveSettingsDebounced();
}

/**
 * Add a new character-specific folder.
 * @param {string} characterId - Character ID.
 * @param {string} name - Name of the new folder.
 * @param {string|null} parent - Parent folder ID, or null for root.
 */
function addCharacterFolder(characterId, name, parent = null) {
    const folders = getCharacterFolders(characterId);
    const id = `char_${characterId}_folder_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    folders.push({ id, name, parent });
    setCharacterFolders(characterId, folders);
}

/**
 * Remove a character-specific folder by its ID.
 * @param {string} characterId - Character ID.
 * @param {string} id - Folder ID.
 */
function removeCharacterFolder(characterId, id) {
    let folders = getCharacterFolders(characterId);
    folders = folders.filter(f => f.id !== id);
    setCharacterFolders(characterId, folders);
}

/**
 * Get character-specific chat-to-folders mapping.
 * @param {string} characterId - Character ID.
 * @returns {Object} Map of chat file name to array of folder IDs.
 */
function getCharacterChatFoldersMap(characterId) {
    try {
        const settings = getSettings();
        if (!settings.characterChatFolders || !settings.characterChatFolders[characterId]) {
            return {};
        }
        return settings.characterChatFolders[characterId].chatFolders || {};
    } catch { return {}; }
}

/**
 * Set character-specific chat-to-folders mapping.
 * @param {string} characterId - Character ID.
 * @param {Object} map - Map of chat file name to array of folder IDs.
 */
function setCharacterChatFoldersMap(characterId, map) {
    const settings = getSettings();
    if (!settings.characterChatFolders) settings.characterChatFolders = {};
    if (!settings.characterChatFolders[characterId]) settings.characterChatFolders[characterId] = { folders: [], chatFolders: {} };
    settings.characterChatFolders[characterId].chatFolders = map;
    saveSettingsDebounced();
}

/**
 * Assign a chat to a character-specific folder.
 * @param {string} characterId - Character ID.
 * @param {string} fileName - Chat file name.
 * @param {string} folderId - Folder ID.
 */
function assignChatToCharacterFolder(characterId, fileName, folderId) {
    const map = getCharacterChatFoldersMap(characterId);
    if (!Array.isArray(map[fileName])) map[fileName] = [];
    if (!map[fileName].includes(folderId)) map[fileName].push(folderId);
    setCharacterChatFoldersMap(characterId, map);
}

/**
 * Remove a chat from a character-specific folder.
 * @param {string} characterId - Character ID.
 * @param {string} fileName - Chat file name.
 * @param {string} folderId - Folder ID.
 */
function removeChatFromCharacterFolder(characterId, fileName, folderId) {
    const map = getCharacterChatFoldersMap(characterId);
    if (Array.isArray(map[fileName])) {
        map[fileName] = map[fileName].filter(id => id !== folderId);
        if (map[fileName].length === 0) delete map[fileName];
    }
    setCharacterChatFoldersMap(characterId, map);
}

/**
 * Build character-specific folderedChats map.
 * @param {string} characterId - Character ID.
 * @param {Array} characterChats - Array of chat objects for this character.
 * @returns {Object} Map of folderId to array of chats.
 */
function buildCharacterFolderedChatsMap(characterId, characterChats) {
    const folderedChats = {};
    const chatFoldersMap = getCharacterChatFoldersMap(characterId);
    
    // Initialize empty arrays for all folders
    const folders = getCharacterFolders(characterId);
    folders.forEach(folder => {
        folderedChats[folder.id] = [];
    });
    
    // Process each chat and assign to folders
    characterChats.forEach(chat => {
        const folderIds = chatFoldersMap[chat.file_name] || [];
        folderIds.forEach(folderId => {
            if (folderedChats[folderId]) {
                folderedChats[folderId].push(chat);
            }
        });
    });
    
    return folderedChats;
}

/**
 * Build character-specific folder tree.
 * @param {string} characterId - Character ID.
 * @returns {Array} Tree structure of folders.
 */
function buildCharacterFolderTree(characterId) {
    const folders = getCharacterFolders(characterId);
    return buildFolderTree(folders); // Reuse existing function
}

/**
 * Render character-specific chat folders UI inside the given container.
 * @param {string} characterId - Character ID.
 * @param {HTMLElement} container - The container to render folders into.
 * @param {Object} folderedChats - Map of folderId to array of chats.
 * @param {Array} [folderNodes] - Optional, for recursion: array of folder nodes.
 * @param {number} [level] - Optional, for recursion: current nesting level.
 */
function renderCharacterChatFoldersUI(characterId, container, folderedChats, folderNodes, level = 0) {
    const folders = getCharacterFolders(characterId).slice().sort((a, b) => a.name.localeCompare(b.name));
    if (!folderNodes) folderNodes = buildCharacterFolderTree(characterId);
    
    // Build a map for quick parent lookup
    const folderMap = Object.fromEntries(folders.map(f => [f.id, f]));
    
    folderNodes.forEach(folder => {
        const folderSection = document.createElement('div');
        folderSection.className = 'collapsible-section folder-collapsible-section';
        folderSection.style.paddingLeft = level === 0 ? '0' : '28px';
        
        const header = document.createElement('div');
        header.className = 'collapsible-header';
        
        const chevron = document.createElement('i');
        chevron.className = 'fa-solid chevron fa-chevron-down';
        header.appendChild(chevron);
        
        const folderTitle = document.createElement('span');
        folderTitle.className = 'folder-title';
        folderTitle.textContent = folder.name;
        folderTitle.style.flex = '1'; // Take up available space
        folderTitle.style.marginLeft = '8px';
        header.appendChild(folderTitle);
        
        // Create action buttons container
        const actionButtons = document.createElement('div');
        actionButtons.className = 'folder-action-buttons';
        actionButtons.style.display = 'flex';
        actionButtons.style.gap = '6px';
        actionButtons.style.marginLeft = 'auto';
        
        // Add pencil icon for renaming
        const pencilIcon = document.createElement('i');
        pencilIcon.className = 'fa-solid fa-pencil-alt folder-rename-icon';
        pencilIcon.style.cursor = 'pointer';
        pencilIcon.style.padding = '4px';
        pencilIcon.title = 'Rename folder';
        actionButtons.appendChild(pencilIcon);
        
        // Add delete icon for deleting folder
        const deleteIcon = document.createElement('i');
        deleteIcon.className = 'fa-solid fa-trash folder-delete-icon';
        deleteIcon.style.cursor = 'pointer';
        deleteIcon.style.padding = '4px';
        deleteIcon.style.color = '#ff6b6b';
        deleteIcon.title = 'Delete folder';
        actionButtons.appendChild(deleteIcon);
        
        header.appendChild(actionButtons);
        
        header.addEventListener('click', (e) => {
            // Expand/collapse if clicking chevron or folder title (not action buttons)
            if (e.target === chevron || e.target === folderTitle) {
                folderSection.classList.toggle('collapsed');
                content.classList.toggle('collapsed');
                if (folderSection.classList.contains('collapsed')) {
                    chevron.classList.remove('fa-chevron-down');
                    chevron.classList.add('fa-chevron-right');
                } else {
                    chevron.classList.remove('fa-chevron-right');
                    chevron.classList.add('fa-chevron-down');
                }
            }
        });
        
        // Rename folder functionality
        pencilIcon.addEventListener('click', async (e) => {
            e.stopPropagation();
            await showRenameFolderPopup(characterId, folder);
        });
        
        // Delete folder functionality
        deleteIcon.addEventListener('click', async (e) => {
            e.stopPropagation();
            await showDeleteFolderPopup(characterId, folder);
        });
        
        const content = document.createElement('div');
        content.className = 'collapsible-content';
        
        folderSection.appendChild(header);
        folderSection.appendChild(content);
        container.appendChild(folderSection);
        
        // Render chats in this folder
        const chatsInFolder = folderedChats[folder.id] || [];
        chatsInFolder.forEach(chat => {
            const chatElement = createCharacterChatElement(characterId, chat);
            content.appendChild(chatElement);
        });
        
        // Render subfolders recursively
        if (folder.children && folder.children.length > 0) {
            renderCharacterChatFoldersUI(characterId, content, folderedChats, folder.children, level + 1);
        }
    });
}

/**
 * Show rename folder popup.
 * @param {string} characterId - Character ID.
 * @param {Object} folder - Folder object.
 */
async function showRenameFolderPopup(characterId, folder) {
    const content = document.createElement('div');
    content.innerHTML = `<h3>Rename folder</h3>`;
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = folder.name;
    nameInput.style.width = '100%';
    nameInput.style.marginTop = '8px';
    nameInput.className = 'chatplus_menu_input';
    content.appendChild(nameInput);
    
    const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
        okButton: t`Rename`,
        cancelButton: t`Cancel`,
        wide: true
    });
    
    nameInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            popup.okButton.click();
        }
    });
    
    const result = await popup.show();
    if ((result === POPUP_RESULT.AFFIRMATIVE) && nameInput.value.trim() && nameInput.value.trim() !== folder.name) {
        // Update folder name
        const folders = getCharacterFolders(characterId);
        const idx = folders.findIndex(f => f.id === folder.id);
        if (idx !== -1) {
            folders[idx].name = nameInput.value.trim();
            setCharacterFolders(characterId, folders);

            // Refresh the character chat modal
            await refreshCharacterChatModal(characterId);
        }
    }
}

/**
 * Show delete folder popup.
 * @param {string} characterId - Character ID.
 * @param {Object} folder - Folder object.
 */
async function showDeleteFolderPopup(characterId, folder) {
    // Count chats in this folder
    const chatFoldersMap = getCharacterChatFoldersMap(characterId);
    let chatsInFolder = 0;
    
    Object.values(chatFoldersMap).forEach(folderIds => {
        if (folderIds.includes(folder.id)) {
            chatsInFolder++;
        }
    });
    
    const content = document.createElement('div');
    content.innerHTML = `
        <h3>Delete folder "${folder.name}"</h3>
        <p>Are you sure you want to delete this folder?</p>
        ${chatsInFolder > 0 ? 
            `<p style="color: #ffa500;">⚠️ This folder contains ${chatsInFolder} chat(s).<br/>
             The chats will be moved to "Uncategorized" and will not be deleted.</p>` : 
            `<p style="color: #888;">This folder is empty.</p>`}
    `;
    
    const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
        okButton: t`Delete`,
        cancelButton: t`Cancel`,
        wide: true
    });
    
    const result = await popup.show();
    if (result === POPUP_RESULT.AFFIRMATIVE) {

        
        // Remove folder from folder list
        let folders = getCharacterFolders(characterId);
        folders = folders.filter(f => f.id !== folder.id);
        setCharacterFolders(characterId, folders);
        
        // Remove folder assignments from all chats (chats become uncategorized)
        const updatedChatFoldersMap = {};
        Object.entries(chatFoldersMap).forEach(([chatFile, folderIds]) => {
            const updatedFolderIds = folderIds.filter(id => id !== folder.id);
            if (updatedFolderIds.length > 0) {
                updatedChatFoldersMap[chatFile] = updatedFolderIds;
            }
            // If no folder IDs left, don't add to map (becomes uncategorized)
        });
        setCharacterChatFoldersMap(characterId, updatedChatFoldersMap);
        

        
        // Refresh the character chat modal
        await refreshCharacterChatModal(characterId);
    }
}

/**
 * Create a chat element for character folder view.
 * @param {string} characterId - Character ID.
 * @param {Object} chat - Chat object.
 * @returns {HTMLElement} Chat element.
 */
function createCharacterChatElement(characterId, chat) {
    const chatDiv = document.createElement('div');
    chatDiv.className = 'select_chat_block_wrapper flex-container';
    
    const chatBlock = document.createElement('div');
    chatBlock.className = 'select_chat_block wide100p flex-container';
    chatBlock.setAttribute('file_name', chat.file_name);
    
    // Check if this is the current chat and add highlight attribute (same as SillyTavern)
    const currentChat = getCurrentChatName();
    const currentTrimmed = trimChatExtension(currentChat);
    const chatTrimmed = trimChatExtension(chat.file_name);
    const isSelected = currentChat && currentTrimmed === chatTrimmed;
    
    if (isSelected) {
        chatBlock.setAttribute('highlight', String(true));
        
    }
    
    // Make it clickable to load the chat
    chatBlock.addEventListener('click', () => {

        
        try {
            // Use SillyTavern's existing chat loading mechanism
            const context = SillyTavern.getContext();
            if (context.selectCharacterById) {
                context.selectCharacterById(characterId);
            }
            
            // Load the specific chat
            if (window.loadFileToChat) {
                window.loadFileToChat(chat.file_name);
            }
            
            // Close the modal
            const modal = document.getElementById('shadow_select_chat_popup');
            if (modal) {
                modal.style.display = 'none';
            }
            
            // Also try clicking the close button
            const closeBtn = document.getElementById('select_chat_cross');
            if (closeBtn) {
                closeBtn.click();
            }
        } catch (error) {
            console.error('ChatPlus: Error loading chat:', error.message);
        }
    });
    
    const nameWrapper = document.createElement('div');
    nameWrapper.id = 'select_chat_name_wrapper';
    nameWrapper.className = 'flex-container alignitemscenter justifySpaceBetween wide100p';
    
    const leftDiv = document.createElement('div');
    leftDiv.className = 'flex-container alignItemsCenter';
    
    const fileName = document.createElement('small');
    fileName.className = 'select_chat_block_filename select_chat_block_filename_item';
    fileName.textContent = chat.file_name;
    leftDiv.appendChild(fileName);
    
    // Add folder management button
    const folderButton = document.createElement('div');
    folderButton.className = 'hoverglow opacity50p fa-solid fa-folder fa-sm';
    folderButton.title = 'Manage folders';
    folderButton.style.marginLeft = '8px';
    folderButton.style.cursor = 'pointer';
    folderButton.addEventListener('click', async (e) => {
        e.stopPropagation();
        await showCharacterChatFolderManagement(characterId, chat.file_name);
    });
    leftDiv.appendChild(folderButton);
    
    nameWrapper.appendChild(leftDiv);
    
    const rightDiv = document.createElement('div');
    rightDiv.className = 'flex-container gap10px alignItemsCenter';
    
    // Chat info
    const chatInfo = document.createElement('div');
    chatInfo.className = 'select_chat_info flex-container';
    
    if (chat.last_mes) {
        const dateSpan = document.createElement('small');
        dateSpan.className = 'chat_messages_date select_chat_block_filename_item';
        
        // Try to format date safely
        try {
            if (typeof timestampToMoment === 'function') {
                dateSpan.textContent = timestampToMoment(chat.last_mes).format('lll');
            } else {
                // Fallback: use regular Date formatting
                const date = new Date(chat.last_mes);
                dateSpan.textContent = date.toLocaleString();
            }
        } catch (dateError) {
            
            dateSpan.textContent = new Date(chat.last_mes || 0).toLocaleString();
        }
        
        chatInfo.appendChild(dateSpan);
    }
    
    if (chat.file_size) {
        const sizeSpan = document.createElement('small');
        sizeSpan.className = 'chat_file_size select_chat_block_filename_item';
        sizeSpan.textContent = `(${chat.file_size},`;
        chatInfo.appendChild(sizeSpan);
    }
    
    if (chat.message_count) {
        const countSpan = document.createElement('small');
        countSpan.className = 'chat_messages_num select_chat_block_filename_item';
        countSpan.textContent = `${chat.message_count} 💬)`;
        chatInfo.appendChild(countSpan);
    }
    
    rightDiv.appendChild(chatInfo);
    nameWrapper.appendChild(rightDiv);
    
    chatBlock.appendChild(nameWrapper);
    
    // Preview message
    if (chat.preview_message) {
        const previewDiv = document.createElement('div');
        previewDiv.className = 'select_chat_block_mes';
        previewDiv.textContent = chat.preview_message;
        chatBlock.appendChild(previewDiv);
    }
    
    chatDiv.appendChild(chatBlock);
    return chatDiv;
}

/**
 * Show character-specific chat folder management popup.
 * @param {string} characterId - Character ID.
 * @param {string} fileName - Chat file name.
 */
async function showCharacterChatFolderManagement(characterId, fileName) {
    const folders = getCharacterFolders(characterId).slice().sort((a, b) => a.name.localeCompare(b.name));
    const currentFolderIds = getCharacterChatFoldersMap(characterId)[fileName] || [];
    
    const content = document.createElement('div');
    content.innerHTML = `<h3>Manage folders for "${fileName}"</h3>`;
    
    // Folder checkboxes
    const foldersDiv = document.createElement('div');
    foldersDiv.style.maxHeight = '300px';
    foldersDiv.style.overflowY = 'auto';
    foldersDiv.style.marginBottom = '10px';
    
    const folderTree = buildCharacterFolderTree(characterId);
    renderFolderCheckboxes(folderTree, foldersDiv, currentFolderIds, 0);
    
    content.appendChild(foldersDiv);
    
    // Add new folder button
    const addFolderBtn = document.createElement('button');
    addFolderBtn.className = 'menu_button';
    addFolderBtn.innerHTML = '<i class="fa-solid fa-plus"></i>&nbsp;&nbsp;Add Folder';
    addFolderBtn.style.whiteSpace = 'nowrap';
    addFolderBtn.style.overflow = 'hidden';
    addFolderBtn.style.textOverflow = 'ellipsis';
    addFolderBtn.addEventListener('click', async () => {
        const folderName = prompt('Enter folder name:');
        if (folderName && folderName.trim()) {
            addCharacterFolder(characterId, folderName.trim());
            
            // Update the modal content instead of opening a new modal
            updateFolderCheckboxes(characterId, fileName, foldersDiv);
        }
    });
    content.appendChild(addFolderBtn);
    
    const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
        okButton: t`Save`,
        cancelButton: t`Cancel`,
        wide: true,
        large: true
    });
    
    const result = await popup.show();
    if (result === POPUP_RESULT.AFFIRMATIVE) {
        // Save selected folders
        const checkedBoxes = content.querySelectorAll('input[type="checkbox"]:checked');
        const selectedFolderIds = Array.from(checkedBoxes).map(cb => cb.value);
        
        const map = getCharacterChatFoldersMap(characterId);
        if (selectedFolderIds.length > 0) {
            map[fileName] = selectedFolderIds;
        } else {
            delete map[fileName];
        }
        setCharacterChatFoldersMap(characterId, map);
        
        // Refresh the character chat modal
        refreshCharacterChatModal(characterId);
    }
}

/**
 * Update folder checkboxes in existing modal (instead of opening new modal).
 * @param {string} characterId - Character ID.
 * @param {string} fileName - File name.
 * @param {HTMLElement} foldersDiv - Container element for checkboxes.
 */
function updateFolderCheckboxes(characterId, fileName, foldersDiv) {
    // Get current selections before clearing
    const currentChecked = Array.from(foldersDiv.querySelectorAll('input[type="checkbox"]:checked'))
        .map(cb => cb.value);
    
    // Clear existing content
    foldersDiv.innerHTML = '';
    
    // Re-render with updated folder list
    const folderTree = buildCharacterFolderTree(characterId);
    renderFolderCheckboxes(folderTree, foldersDiv, currentChecked, 0);
    

}

function renderFolderCheckboxes(folderTree, container, selectedIds, level = 0) {
    folderTree.forEach(folder => {
        const label = document.createElement('label');
        label.style.display = 'flex';
        label.style.alignItems = 'center';
        label.style.marginLeft = (level * 20) + 'px';
        label.style.marginBottom = '4px';
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = folder.id;
        checkbox.checked = selectedIds.includes(folder.id);
        
        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(' 📁 ' + folder.name));
        container.appendChild(label);
        
        if (folder.children && folder.children.length > 0) {
            renderFolderCheckboxes(folder.children, container, selectedIds, level + 1);
        }
    });
}

/**
 * Refresh character chat modal with current view mode.
 * @param {string} characterId - Character ID.
 */
async function refreshCharacterChatModal(characterId) {
    const isFolderView = localStorage.getItem('chatplus_character_view_mode') === 'folder';
    if (isFolderView) {
        await renderCharacterFolderView(characterId);
    } else {
        // Trigger displayPastChats to refresh list view
        try {
            const context = SillyTavern?.getContext();
            if (context && context.displayPastChats) {
                await context.displayPastChats();
            }
        } catch (error) {
            console.error('ChatPlus: Error refreshing chat modal:', error.message);
        }
    }
}

/**
 * Render character folder view.
 * @param {string} characterId - Character ID.
 */
async function renderCharacterFolderView(characterId) {

    
    const selectChatDiv = document.getElementById('select_chat_div');
    if (!selectChatDiv) {

        return;
    }
    
    selectChatDiv.innerHTML = '';
    
    // Check if we have a valid character ID
    if (!characterId || characterId === undefined || characterId === null) {

        selectChatDiv.innerHTML = `
            <div style="text-align: center; padding: 40px; color: #888;">
                <div style="font-size: 18px; margin-bottom: 10px;">⚠️ Cannot load folder view</div>
                <div>Character ID not found. Please try:</div>
                <ul style="text-align: left; margin: 20px auto; max-width: 300px;">
                    <li>Refreshing the page</li>
                    <li>Selecting a character first</li>
                    <li>Using List View instead</li>
                </ul>
                <button onclick="localStorage.setItem('chatplus_character_view_mode', 'list'); location.reload();" 
                        style="padding: 8px 16px; margin-top: 10px; background: #4a9eff; color: white; border: none; border-radius: 4px; cursor: pointer;">
                    Switch to List View
                </button>
            </div>
        `;
        return;
    }
    
    // Get character chats
    const context = SillyTavern.getContext();
    let characterChats = [];
    
    try {

        
        // Handle both array and object character structures
        let character = null;
        if (context?.characters) {
            if (Array.isArray(context.characters)) {

                const charIndex = parseInt(characterId);
                if (!isNaN(charIndex) && charIndex >= 0 && charIndex < context.characters.length) {
                    character = context.characters[charIndex];

                } else {

                }
            } else {

                character = context.characters[characterId];

            }
        }
        
        if (character && character.avatar) {

            
            const response = await fetch('/api/chats/search', {
                method: 'POST',
                headers: context.getRequestHeaders(),
                body: JSON.stringify({
                    query: '',
                    avatar_url: character.avatar,
                    group_id: null,
                }),
            });
            
            if (response.ok) {
                characterChats = await response.json();

                
                // Sort chats by timestamp (most recent first)
                try {
                    if (typeof context.sortMoments === 'function' && typeof timestampToMoment === 'function') {
                        characterChats.sort((a, b) => context.sortMoments(timestampToMoment(a.last_mes), timestampToMoment(b.last_mes)));
                    } else {
                        // Fallback: sort by timestamp directly
                        characterChats.sort((a, b) => {
                            const timeA = a.last_mes || 0;
                            const timeB = b.last_mes || 0;
                            return timeB - timeA; // Most recent first
                        });
                    }

                } catch (sortError) {
                    console.warn('ChatPlus: Could not sort chats, using fallback order:', sortError.message);
                    // Continue without sorting
                }
            } else {
                console.error('ChatPlus: Failed to fetch chats, HTTP status:', response.status);
            }
        } else {

            selectChatDiv.innerHTML = `
                <div style="text-align: center; padding: 40px; color: #888;">
                    <div style="font-size: 18px; margin-bottom: 10px;">⚠️ Character not found</div>
                    <div>Character ID "${characterId}" does not exist or has no avatar.</div>
                </div>
            `;
            return;
        }
    } catch (error) {
        console.error('ChatPlus: Error loading character chats:', error.message);
        selectChatDiv.innerHTML = `
            <div style="text-align: center; padding: 40px; color: #888;">
                <div style="font-size: 18px; margin-bottom: 10px;">❌ Error loading chats</div>
                <div>Failed to load chat data: ${error.message}</div>
            </div>
        `;
        return;
    }
    
    // Build foldered chats map
    const folderedChats = buildCharacterFolderedChatsMap(characterId, characterChats);
    
    // Create folders container
    const foldersContainer = document.createElement('div');
    foldersContainer.className = 'character-folders-container';
    
    // Add folder management buttons
    const folderControls = document.createElement('div');
    folderControls.className = 'folder-controls';
    folderControls.style.marginBottom = '15px';
    folderControls.style.display = 'flex';
    folderControls.style.gap = '10px';
    
    const addFolderBtn = document.createElement('button');
    addFolderBtn.className = 'menu_button';
    addFolderBtn.innerHTML = '<i class="fa-solid fa-plus"></i>&nbsp;&nbsp;Add Folder';
    addFolderBtn.style.whiteSpace = 'nowrap';
    addFolderBtn.style.overflow = 'hidden';
    addFolderBtn.style.textOverflow = 'ellipsis';
    addFolderBtn.addEventListener('click', async () => {
        const folderName = prompt('Enter folder name:');
        if (folderName && folderName.trim()) {
            addCharacterFolder(characterId, folderName.trim());
            await refreshCharacterChatModal(characterId);
        }
    });
    folderControls.appendChild(addFolderBtn);
    
    foldersContainer.appendChild(folderControls);
    
    // Render folder structure first (user-created folders)
    const folderTree = buildCharacterFolderTree(characterId);
    if (folderTree.length > 0) {
        renderCharacterChatFoldersUI(characterId, foldersContainer, folderedChats, folderTree);
    }
    
    // Render uncategorized chats last
    const uncategorizedChats = characterChats.filter(chat => {
        const folderIds = getCharacterChatFoldersMap(characterId)[chat.file_name] || [];
        return folderIds.length === 0;
    });
    
    if (uncategorizedChats.length > 0) {
        const uncategorizedSection = document.createElement('div');
        uncategorizedSection.className = 'uncategorized-section';
        uncategorizedSection.style.marginTop = '20px'; // Add space above uncategorized
        
        const header = document.createElement('div');
        header.className = 'folder-header';
        header.innerHTML = '<i class="fa-solid fa-folder-open"></i> Uncategorized';
        header.style.fontWeight = 'bold';
        header.style.marginBottom = '10px';
        header.style.color = '#888';
        
        uncategorizedSection.appendChild(header);
        
        uncategorizedChats.forEach(chat => {
            const chatElement = createCharacterChatElement(characterId, chat);
            uncategorizedSection.appendChild(chatElement);
        });
        
        foldersContainer.appendChild(uncategorizedSection);
    }
    
    selectChatDiv.appendChild(foldersContainer);
}


// =========================
// 3. Utility Functions
// =========================
/**
 * Prompt the user to select a folder or 'Pinned' for a chat using a SillyTavern popup.
 * Shows folders as a tree with indentation.
 * @param {Object} chat - Chat object.
 * @returns {Promise<string|null>} The selected folderId, 'pinned', or null if cancelled.
 */
async function promptSelectFolderOrPinned(chat) {
    const folders = getFolders().slice().sort((a, b) => a.name.localeCompare(b.name));
    // Helper: render radios as tree, with chat previews
    function renderFolderRadios(nodes, radioName, container, level = 0) {
        nodes.forEach(folder => {
            const label = document.createElement('label');
            label.style.display = 'flex';
            label.style.alignItems = 'center';
            label.style.marginLeft = (level * 20) + 'px';
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = radioName;
            radio.value = folder.id;
            label.appendChild(radio);
            label.appendChild(document.createTextNode(' 📁 ' + folder.name));
            container.appendChild(label);
            // Chat preview for this folder 
            const folderChats = Object.entries(getChatFoldersMap())
                .filter(([key, ids]) => Array.isArray(ids) && ids.includes(folder.id))
                .map(([key]) => {
                    const [characterId, file_name] = key.split(':');
                    return { characterId, file_name };
                });
            if (folderChats.length > 0) {
                const previewContainer = document.createElement('div');
                previewContainer.className = 'folder-preview-chats';
                previewContainer.style.marginLeft = (level * 20 + 32) + 'px';
                previewContainer.style.marginBottom = '4px';
                folderChats.slice(0, 3).forEach(chatObj => {
                    // Find character info
                    let char = null;
                    let isGroup = false;
                    if (SillyTavern.getContext().characters && SillyTavern.getContext().characters[chatObj.characterId]) {
                        char = SillyTavern.getContext().characters[chatObj.characterId];
                    } else {
                        // Check if this is a group chat
                        const group = groups.find(g => g.id === chatObj.characterId);
                        if (group) {
                            isGroup = true;
                            char = { name: group.name || `Group ${group.id}`, avatar: group.avatar || '' };
                        }
                    }
                    const chat = {
                        character: char ? (char.name || chatObj.characterId) : chatObj.characterId,
                        avatar: char ? char.avatar : '',
                        file_name: chatObj.file_name,
                        characterId: chatObj.characterId,
                        stat: undefined,
                        isGroup: isGroup
                    };
                    // Try to get stat if available
                    if (typeof getPastCharacterChats === 'function') {
                        // This is async, but for preview, we skip stat or use cached if available
                        // Optionally, you could cache stats elsewhere for more detail
                    }
                    // Render preview using .tabItem-singleline style
                    const tabItem = document.createElement('div');
                    tabItem.classList.add('tabItem', 'tabItem-singleline');
                    tabItem.style.display = 'flex';
                    tabItem.style.flexDirection = 'row';
                    tabItem.style.alignItems = 'center';
                    tabItem.style.gap = '10px';
                    tabItem.style.marginBottom = '2px';

                    // Character/Group image (character = img, group = div)
                    let previewImg;
                    if (isGroup) {
                        previewImg = document.createElement('div');
                        previewImg.className = 'tabItem-previewImg group-preview';

                        const group = groups.find(g => g.id === chatObj.characterId);
                        if (group) {
                            let result = getGroupAvatar(group);
                            if (result && result.length > 0) {
                                const groupElement = result[0];
                                groupElement.style.width = '100%';
                                groupElement.style.height = '100%';
                                groupElement.style.minWidth = 'unset';
                                previewImg.appendChild(groupElement);
                            }
                        }
                    } else {
                        previewImg = document.createElement('img');
                        previewImg.className = 'tabItem-previewImg';
                        previewImg.src = typeof getThumbnailUrl === 'function' ? getThumbnailUrl('avatar', chat.avatar) : (chat.avatar || '');
                        previewImg.alt = chat.character || '';
                    }
                    const nameRow = document.createElement('div');
                    nameRow.className = 'tabItem-nameRow';
                    nameRow.textContent = `${chat.character}: ${chat.file_name}`;
                    tabItem.appendChild(previewImg);
                    tabItem.appendChild(nameRow);
                    previewContainer.appendChild(tabItem);
                });
                if (folderChats.length > 3) {
                    const more = document.createElement('div');
                    more.style.fontSize = '0.9em';
                    more.style.color = '#888';
                    more.style.marginLeft = '4px';
                    more.textContent = `+${folderChats.length - 3} more`;
                    previewContainer.appendChild(more);
                }
                container.appendChild(previewContainer);
            }
            if (folder.children && folder.children.length > 0) {
                renderFolderRadios(folder.children, radioName, container, level + 1);
            }
        });
    }
    // Build popup content
    const content = document.createElement('div');
    content.className = 'pin-popup-content';
    content.innerHTML = `<h3>${t`Pin or folder chat`}</h3>`;
    // Chat preview for the chat being pinned
    const previewContainer = document.createElement('div');
    previewContainer.className = 'pin-popup-chat-preview';
    previewContainer.style.margin = '8px 0 12px 0';
    // Build the preview using .tabItem-singleline style
    const tabItem = document.createElement('div');
    tabItem.classList.add('tabItem', 'tabItem-singleline');
    tabItem.style.display = 'flex';
    tabItem.style.flexDirection = 'row';
    tabItem.style.alignItems = 'center';
    tabItem.style.gap = '10px';
    tabItem.style.marginBottom = '2px';

    // Character/Group image (character = img, group = div)
    // Check if this is a group chat
    const isGroup = chat.isGroup || false;
    let previewImg;
    if (isGroup) {
        previewImg = document.createElement('div');
        previewImg.className = 'tabItem-previewImg group-preview';

        const group = groups.find(g => g.id === chat.characterId);
        if (group) {
            let result = getGroupAvatar(group);
            if (result && result.length > 0) {
                const groupElement = result[0];
                groupElement.style.width = '100%';
                groupElement.style.height = '100%';
                groupElement.style.minWidth = 'unset';
                previewImg.appendChild(groupElement);
            }
        }
    } else {
        previewImg = document.createElement('img');
        previewImg.className = 'tabItem-previewImg';
        previewImg.src = typeof getThumbnailUrl === 'function' ? getThumbnailUrl('avatar', chat.avatar) : (chat.avatar || '');
        previewImg.alt = chat.character || '';
    }

    const nameRow = document.createElement('div');
    nameRow.className = 'tabItem-nameRow';
    nameRow.textContent = `${chat.character}: ${chat.file_name}`;
    tabItem.appendChild(previewImg);
    tabItem.appendChild(nameRow);
    previewContainer.appendChild(tabItem);
    content.appendChild(previewContainer);

    // Separator between chat preview and pinned chats
    const separatorPreviewToPinned = document.createElement('hr');
    separatorPreviewToPinned.style.margin = '8px 0';
    content.appendChild(separatorPreviewToPinned);

    const radioGroup = document.createElement('div');
    radioGroup.className = 'chatplus_radio_group';
    const radioName = 'pin-folder-radio';
    // Option for pinned
    const pinnedLabel = document.createElement('label');
    pinnedLabel.style.display = 'flex';
    pinnedLabel.style.alignItems = 'center';
    const pinnedRadio = document.createElement('input');
    pinnedRadio.type = 'radio';
    pinnedRadio.name = radioName;
    pinnedRadio.value = 'pinned';
    pinnedRadio.checked = true;
    pinnedLabel.appendChild(pinnedRadio);
    pinnedLabel.appendChild(document.createTextNode(' 📌 ' + t`Pinned section`));
    radioGroup.appendChild(pinnedLabel);
    // Preview pinned chats 
    const pinnedChats = getPinnedChats();
    if (pinnedChats.length > 0) {
        const pinnedPreviewContainer = document.createElement('div');
        pinnedPreviewContainer.className = 'pinned-preview-chats';
        pinnedPreviewContainer.style.marginLeft = '32px';
        pinnedPreviewContainer.style.marginBottom = '4px';
        pinnedChats.forEach(chatObj => {
            let char = null;
            let isGroup = false;
            if (SillyTavern.getContext().characters && SillyTavern.getContext().characters[chatObj.characterId]) {
                char = SillyTavern.getContext().characters[chatObj.characterId];
            } else {
                // Check if this might be a group chat by checking if the ID exists in groups
                const group = groups.find(g => g.id === chatObj.characterId);
                if (group) {
                    isGroup = true;
                    char = { name: group.name || `Group ${group.id}`, avatar: group.avatar || '' };
                }
            }

            const chat = {
                character: char ? (char.name || chatObj.characterId) : chatObj.characterId,
                avatar: char ? char.avatar : '',
                file_name: chatObj.file_name,
                characterId: chatObj.characterId,
                stat: undefined,
                isGroup: isGroup
            };
            const tabItem = document.createElement('div');
            tabItem.classList.add('tabItem', 'tabItem-singleline');
            tabItem.style.display = 'flex';
            tabItem.style.flexDirection = 'row';
            tabItem.style.alignItems = 'center';
            tabItem.style.gap = '10px';
            tabItem.style.marginBottom = '2px';

            // Character/Group image (character = img, group = div)
            let previewImg;
            if (isGroup) {
                previewImg = document.createElement('div');
                previewImg.className = 'tabItem-previewImg group-preview';

                const group = groups.find(g => g.id === chatObj.characterId);
                if (group) {
                    let result = getGroupAvatar(group);
                    if (result && result.length > 0) {
                        const groupElement = result[0];
                        groupElement.style.width = '100%';
                        groupElement.style.height = '100%';
                        groupElement.style.minWidth = 'unset';
                        previewImg.appendChild(groupElement);
                    }
                }
            } else {
                previewImg = document.createElement('img');
                previewImg.className = 'tabItem-previewImg';
                previewImg.src = typeof getThumbnailUrl === 'function' ? getThumbnailUrl('avatar', chat.avatar) : (chat.avatar || '');
                previewImg.alt = chat.character || '';
            }

            const nameRow = document.createElement('div');
            nameRow.className = 'tabItem-nameRow';
            nameRow.textContent = `${chat.character}: ${chat.file_name}`;
            tabItem.appendChild(previewImg);
            tabItem.appendChild(nameRow);
            pinnedPreviewContainer.appendChild(tabItem);
        });
        radioGroup.appendChild(pinnedPreviewContainer);
    }

    // Separator between pinned and folders
    const separatorPinnedToFolders = document.createElement('hr');
    separatorPinnedToFolders.style.margin = '8px 0';
    radioGroup.appendChild(separatorPinnedToFolders);

    // Render folder radios as tree, with previews
    const folderTree = buildFolderTree(folders);
    renderFolderRadios(folderTree, radioName, radioGroup, 0);
    content.appendChild(radioGroup);
    const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
        cancelButton: t`Cancel`,
        wide: true,
        large: true,
    });
    const popupResult = await popup.show();
    if (popupResult === POPUP_RESULT.CANCELLED || popupResult === 0) return null; // Popup cancelled by the user

    const selectedRadio = content.querySelector('input[type="radio"]:checked');
    const result = selectedRadio && selectedRadio.value ? selectedRadio.value : null;
    return result || null;
}

// =========================
// 4. Chat Data Fetching
// =========================
/**
 * Fetch the list of chat file names for a character by avatar.
 * @param {string} avatar - Avatar URL or identifier.
 * @returns {Promise<string[]>} List of chat file names.
 */
async function getListOfCharacterChats(avatar) {
    try {
        const result = await fetch('/api/characters/chats', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, simple: true }),
        });
        if (!result.ok) return [];
        const data = await result.json();
        if (!Array.isArray(data)) {
            console.warn('Skipping character chats: data is not an array', data);
            return [];
        }
        return data.map(x => String(x.file_name).replace('.jsonl', ''));
    } catch (error) {
        console.warn('Failed to get list of character chats, skipping', error);
        return [];
    }
}

/**
 * Get the list of chat files for the current chat context (group or character).
 * @returns {Promise<Array>} List of chat files.
 */
async function getChatFiles() {
    const context = SillyTavern.getContext();
    const chatId = getCurrentChatId();
    if (!chatId) return [];
    if (context.groupId) return await getGroupPastChats(context.groupId);
    if (context.characterId !== undefined) return await getPastCharacterChats(context.characterId);
    return [];
}

/**
 * Open a chat by its ID, switching to the appropriate group or character chat.
 * @param {string} chatId - The chat file name or ID.
 * @param {boolean} isGroup - Whether this is a group chat.
 * @param {string|null} groupId - The group ID if this is a group chat.
 */
async function openChatById(chatId, isGroup = false, groupId = null) {
    const context = SillyTavern.getContext();
    if (!chatId) return;

    if (isGroup && groupId && typeof openGroupChat === 'function') {
        await openGroupChat(groupId, chatId);
    } else if (context.groupId && typeof openGroupChat === 'function') {
        await openGroupChat(context.groupId, chatId);
    } else if (context.characterId !== undefined && typeof openCharacterChat === 'function') {
        await openCharacterChat(chatId);
    }
    // Call the window["chatsPlusRenderSelectedChat"] to update the "Currently Selected Chats"
    window['chatsPlusRenderSelectedChat'](chatId);
    return;
}

// =========================
// 5. UI Rendering Functions
// =========================
/**
 * Get or create the container for the Recent Chats tab.
 * @returns {HTMLElement|null} The container element or null if not found.
 */
function getOrCreateRecentChatsTabContainer() {
    if (recentChatsTabContainer && document.body.contains(recentChatsTabContainer)) return recentChatsTabContainer;
    const menu = document.getElementById('right-nav-panel');
    if (!menu) return null;
    const tabContent = menu.querySelector('.chatsplus-tab-content');
    if (!tabContent) return null;
    let recentChatsTab = tabContent.children[1];
    if (!recentChatsTab) return null;
    recentChatsTab.innerHTML = '';
    recentChatsTabContainer = recentChatsTab;
    return recentChatsTabContainer;
}

/**
 * Render all chats in the Recent Chats tab, including loader and main container.
 * Calls populateAllChatsTab to fill the content.
 */
async function renderAllChatsInRecentChatsTab() {
    const container = getOrCreateRecentChatsTabContainer();
    if (!container) return;
    if (container.querySelector('#extensionAllChatsTabContainer')) return;
    // Add filter input at the top 
    const filterRow = document.createElement('div');
    filterRow.className = 'filter-row';

    // Create input wrapper for positioning the clear button
    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'filter-input-wrapper';
    inputWrapper.style.position = 'relative';
    inputWrapper.style.display = 'flex';
    inputWrapper.style.alignItems = 'center';

    const filterInput = document.createElement('input');
    filterInput.type = 'text';
    filterInput.placeholder = 'Filter chats...';
    filterInput.className = 'filter-input';
    filterInput.style.paddingRight = '30px'; // Make room for the clear button

    // Create clear button
    const clearButton = document.createElement('button');
    clearButton.className = 'filter-clear-button';
    clearButton.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    clearButton.title = 'Clear filter';

    inputWrapper.appendChild(filterInput);
    inputWrapper.appendChild(clearButton);
    filterRow.appendChild(inputWrapper);
    container.appendChild(filterRow);
    // Loader and main container 
    const loader = document.createElement('div');
    loader.id = 'extensionAllChatsTabLoader';
    loader.className = 'allChatsTabLoader'; // Initially hidden
    const loaderIcon = document.createElement('i');
    loaderIcon.className = 'fa-2x fa-solid fa-gear fa-spin';
    loader.appendChild(loaderIcon);
    container.appendChild(loader);
    const chatsTabContainer = document.createElement('div');
    chatsTabContainer.id = 'extensionAllChatsTabContainer';
    container.appendChild(chatsTabContainer);
    // Load More button
    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.id = 'extensionAllChatsTabLoadMoreBtn';
    loadMoreBtn.classList.add('load-more-btn');
    loadMoreBtn.classList.add('hidden'); // Initially hidden
    loadMoreBtn.textContent = 'Load More';
    container.appendChild(loadMoreBtn);
    // Filtering and pagination logic
    let lastFilter = '';
    let lastChatsData = null;
    let offset = 0;
    let totalChats = 0;
    async function doPopulate(filterValue, append = false) {
        lastFilter = filterValue;
        const result = await populateAllChatsTab({
            container: chatsTabContainer,
            loader,
            tab: container,
            filter: filterValue,
            cache: lastChatsData,
            setCache: (data) => { lastChatsData = data; },
            offset,
            append
        });
        totalChats = result && result.totalChats ? result.totalChats : 0;
        if (offset + MAX_RECENT_CHATS < totalChats) {
            loadMoreBtn.classList.remove('hidden');
        } else {
            loadMoreBtn.classList.add('hidden');
        }
    }
    filterInput.addEventListener('input', (e) => {
        offset = 0;
        chatsTabContainer.innerHTML = '';
        doPopulate(e.target.value.trim());

        // Show/hide clear button based on input content
        if (e.target.value.trim().length > 0) {
            clearButton.style.display = 'block';
        } else {
            clearButton.style.display = 'none';
        }
    });

    // Clear button functionality
    clearButton.addEventListener('click', () => {
        filterInput.value = '';
        clearButton.style.display = 'none';
        offset = 0;
        chatsTabContainer.innerHTML = '';
        doPopulate('');
        filterInput.focus(); // Keep focus on the input after clearing
    });
    loadMoreBtn.addEventListener('click', () => {
        offset += MAX_RECENT_CHATS;
        doPopulate(lastFilter, true);
    });
    // Initial population
    await doPopulate('', false);
}

/**
 * Populate the All Chats tab with chat items, grouped and sorted.
 * @param {Object} param0 - Options for population.
 * @param {HTMLElement} param0.container - The container to render into.
 * @param {HTMLElement} param0.loader - Loader element.
 * @param {HTMLElement} param0.tab - Tab element.
 * @param {string} [param0.filter] - Optional filter string.
 * @param {Object} [param0.cache] - Optional cache of chat data.
 * @param {Function} [param0.setCache] - Optional callback to set cache.
 * @param {number} [param0.offset] - Offset for pagination.
 * @param {boolean} [param0.append] - Whether to append to container.
 * @returns {Object} - { totalChats }
 */
async function populateAllChatsTab({ container, loader, tab, filter = '', cache = null, setCache = null, offset = 0, append = false } = {}) {
    container = container || document.getElementById('extensionAllChatsTabContainer');
    loader = loader || document.getElementById('extensionAllChatsTabLoader');
    if (!loader || !container) return { totalChats: 0 };
    loader.classList.remove('displayNone');
    if (!append) container.innerHTML = '';
    let allChats = [];
    let chatStatsMap = {};
    let groupsMap = {}; // Add groups map for caching
    if (cache && cache.allChats && cache.chatStatsMap) {
        allChats = cache.allChats;
        chatStatsMap = cache.chatStatsMap;
        groupsMap = cache.groupsMap || {}; // Include groups in cache
    } else {
        const context = SillyTavern.getContext();
        const characters = context.characters || {};

        // 1. Fetch all chat lists for all characters in parallel
        const chatListPromises = Object.entries(characters).map(async ([charId, char]) => {
            try {
                const chats = await getListOfCharacterChats(char.avatar);
                return chats.filter(chatName => typeof chatName === 'string' && chatName).map(chatName => ({
                    character: char.name || charId,
                    avatar: char.avatar,
                    file_name: chatName,
                    characterId: charId,
                    isGroup: false
                }));
            } catch (e) {
                return [];
            }
        });

        // 2. Fetch all group chats in parallel
        let groupChats = [];
        try {
            const groupsResponse = await fetch('/api/groups/all', {
                method: 'POST',
                headers: getRequestHeaders(),
            });
            if (groupsResponse.ok) {
                const groups = await groupsResponse.json();

                // Build groups map for later use
                groupsMap = Object.fromEntries(groups.map(group => [group.id, group]));

                const groupChatPromises = groups.map(async (group) => {
                    try {
                        const chats = await getGroupPastChats(group.id);
                        return chats.map(chat => {
                            const fileName = typeof chat === 'string' ? chat.replace('.jsonl', '') : String(chat.file_name || chat).replace('.jsonl', '');
                            return {
                                character: group.name || `Group ${group.id}`,
                                avatar: group.avatar || '', // Groups might have avatars
                                file_name: fileName,
                                characterId: group.id,
                                isGroup: true,
                                groupMembers: group.members || [] // Store group member info
                            };
                        });
                    } catch (e) {
                        return [];
                    }
                });

                const groupChatLists = await Promise.all(groupChatPromises);
                groupChats = groupChatLists.flat();
            }
        } catch (e) {
            console.warn('Failed to load group chats:', e);
        }

        const characterChatLists = await Promise.all(chatListPromises);
        allChats = [...characterChatLists.flat(), ...groupChats];

        // 3. Fetch stats for both character and group chats
        const uniqueCharacterIds = [...new Set(allChats.filter(chat => !chat.isGroup).map(chat => chat.characterId))];
        const uniqueGroupIds = [...new Set(allChats.filter(chat => chat.isGroup).map(chat => chat.characterId))];

        // Character stats
        const characterStatsPromises = uniqueCharacterIds.map(async (charId) => {
            try {
                const statsList = await getPastCharacterChats(charId);
                return statsList.map(stat => {
                    const fileName = String(stat.file_name).replace('.jsonl', '');
                    return [charId + ':' + fileName, stat];
                });
            } catch (e) {
                return [];
            }
        });

        // Group stats
        const groupStatsPromises = uniqueGroupIds.map(async (groupId) => {
            try {
                const statsList = await getGroupPastChats(groupId);
                return statsList.map(stat => {
                    const fileName = typeof stat === 'string' ? stat.replace('.jsonl', '') : String(stat.file_name || stat).replace('.jsonl', '');
                    return [groupId + ':' + fileName, stat];
                });
            } catch (e) {
                return [];
            }
        });

        const statsEntries = (await Promise.all([...characterStatsPromises, ...groupStatsPromises])).flat();
        chatStatsMap = Object.fromEntries(statsEntries);
        if (setCache) setCache({ allChats, chatStatsMap, groupsMap }); // Include groups in cache
    }
    allChats = allChats.map(chat => {
        const stat = chatStatsMap[chat.characterId + ':' + chat.file_name];
        let lastMesRaw = stat && stat.last_mes ? stat.last_mes : null;
        let lastMesDate = null;
        if (lastMesRaw) {
            // Use timestampToMoment (dayjs wrapper) for robust parsing
            const momentObj = timestampToMoment(lastMesRaw);
            if (momentObj && momentObj.isValid()) {
                lastMesDate = momentObj.toDate();
            }
        }
        return { ...chat, stat, last_mes: lastMesDate };
    }).filter(chat => chat.last_mes);
    // Ensure allChats is a flat array and sort strictly by date
    allChats.sort((a, b) => b.last_mes - a.last_mes);
    // Filtering
    let filterLower = filter ? filter.toLowerCase() : '';
    function chatMatches(chat) {
        if (!filterLower) return true;
        return (
            (chat.character && chat.character.toLowerCase().includes(filterLower)) ||
            (chat.file_name && chat.file_name.toLowerCase().includes(filterLower)) ||
            (chat.stat && chat.stat.mes && chat.stat.mes.toLowerCase().includes(filterLower))
        );
    }
    const filteredChats = allChats.filter(chatMatches);
    const totalChats = filteredChats.length;
    const chatsToShow = filteredChats.slice(offset, offset + MAX_RECENT_CHATS);
    // Render pinned and recent chats (filtered, paginated) (always render all pinned chats, not just those in the current page)
    const pinnedChatsRaw = getPinnedChats();
    const pinnedChats = pinnedChatsRaw.map(pinned => {
        // Try to find stat info from chatStatsMap
        const stat = chatStatsMap[pinned.characterId + ':' + pinned.file_name];
        // Try to get character info from allChats or SillyTavern context
        let chatInfo = allChats.find(c => c.characterId === pinned.characterId && c.file_name === pinned.file_name);
        if (!chatInfo) {
            // Fallback: try to get character info from context
            const context = SillyTavern.getContext();
            const char = context.characters && context.characters[pinned.characterId];

            // Check if this might be a group chat (groups would not be in context.characters)
            if (!char) {
                // This could be a group chat, check groupsMap
                const group = groupsMap[pinned.characterId];
                chatInfo = {
                    character: group ? (group.name || `Group ${group.id}`) : pinned.characterId,
                    avatar: group ? (group.avatar || '') : '',
                    file_name: pinned.file_name,
                    characterId: pinned.characterId,
                    stat: stat,
                    last_mes: stat && stat.last_mes ? timestampToMoment(stat.last_mes).toDate() : null,
                    isGroup: true,
                    groupMembers: group ? (group.members || []) : []
                };
            } else {
                chatInfo = {
                    character: char.name || pinned.characterId,
                    avatar: char.avatar || '',
                    file_name: pinned.file_name,
                    characterId: pinned.characterId,
                    stat: stat,
                    last_mes: stat && stat.last_mes ? timestampToMoment(stat.last_mes).toDate() : null,
                    isGroup: false
                };
            }
        } else {
            chatInfo = { ...chatInfo, stat };
        }
        return chatInfo;
    }).filter(chat => chat && chat.last_mes && chatMatches(chat));
    // Sort pinned chats alphabetically by character, then file_name
    pinnedChats.sort((a, b) => {
        const charA = (a.character || '').toLowerCase();
        const charB = (b.character || '').toLowerCase();
        if (charA < charB) return -1;
        if (charA > charB) return 1;
        const fileA = (a.file_name || '').toLowerCase();
        const fileB = (b.file_name || '').toLowerCase();
        if (fileA < fileB) return -1;
        if (fileA > fileB) return 1;
        return 0;
    });
    // Render all pinned chats at the top
    if (pinnedChats.length > 0) {
        // Add pinned section header
        const pinnedSeparator = document.createElement('div');
        pinnedSeparator.className = 'allChatsDateSeparator pinned-section-header';
        pinnedSeparator.textContent = '📌 ' + t`Pinned Chats`;
        pinnedSeparator.style.fontWeight = 'bold';
        container.appendChild(pinnedSeparator);

        for (const chat of pinnedChats) {
            renderAllChatsTabItem(chat, container, true, null);
        }
    }
    // Render recent chats (filtered)
    let lastDate = null;
    if (append) {
        // Find the last date separator in the container
        const dateSeparators = Array.from(container.querySelectorAll('.allChatsDateSeparator'));
        if (dateSeparators.length > 0) {
            const lastSeparator = dateSeparators[dateSeparators.length - 1];
            lastDate = lastSeparator.getAttribute('data-date') || null;
        }
    }
    for (const chat of chatsToShow) {
        const stat = chat.stat;
        const chatMoment = stat && stat.last_mes ? timestampToMoment(stat.last_mes) : null;
        const chatDateStr = chatMoment ? chatMoment.format('YYYY-MM-DD') : '';
        if (chatDateStr !== lastDate) {
            lastDate = chatDateStr;
            const dateSeparator = document.createElement('div');
            dateSeparator.className = 'allChatsDateSeparator';
            dateSeparator.textContent = chatMoment ? chatMoment.format('LL') : '';
            dateSeparator.setAttribute('data-date', chatDateStr); // For tracking
            container.appendChild(dateSeparator);
        }
        renderAllChatsTabItem(chat, container, false, null);
    }
    loader.classList.add('displayNone');
    return { totalChats };
}

/**
 * Build a tree structure from the flat folder list.
 * @param {Array} folders - Flat array of folder objects.
 * @returns {Array} Array of root folder nodes, each with children property.
 */
function buildFolderTree(folders) {
    const idToNode = {};
    folders.forEach(folder => {
        idToNode[folder.id] = { ...folder, children: [] };
    });
    const roots = [];
    folders.forEach(folder => {
        if (folder.parent && idToNode[folder.parent]) {
            idToNode[folder.parent].children.push(idToNode[folder.id]);
        } else {
            roots.push(idToNode[folder.id]);
        }
    });
    return roots;
}

/**
 * Render all chat folders UI inside the given container, with nested subfolders.
 * @param {HTMLElement} container - The container to render folders into.
 * @param {Object} folderedChats - Map of folderId to array of chats.
 * @param {Array} [folderNodes] - Optional, for recursion: array of folder nodes.
 * @param {number} [level] - Optional, for recursion: current nesting level.
 */
function renderAllChatsFoldersUI(container, folderedChats, folderNodes, level = 0) {
    const folders = getFolders().slice().sort((a, b) => a.name.localeCompare(b.name));
    if (!folderNodes) folderNodes = buildFolderTree(folders);
    // Build a map for quick parent lookup
    const folderMap = Object.fromEntries(folders.map(f => [f.id, f]));
    folderNodes.forEach(folder => {
        const folderSection = document.createElement('div');
        folderSection.className = 'collapsible-section folder-collapsible-section';
        folderSection.style.paddingLeft = level === 0 ? '0' : '28px';
        const header = document.createElement('div');
        header.className = 'collapsible-header';
        const chevron = document.createElement('i');
        chevron.className = 'fa-solid chevron fa-chevron-down';
        header.appendChild(chevron);
        // Add pencil icon for renaming
        const pencilIcon = document.createElement('i');
        pencilIcon.className = 'fa-solid fa-pencil-alt folder-rename-icon';
        pencilIcon.style.cursor = 'pointer';
        pencilIcon.style.margin = '0 6px 0 6px';
        header.appendChild(pencilIcon);
        const folderTitle = document.createElement('span');
        folderTitle.className = 'folder-title';
        folderTitle.textContent = folder.name;
        header.appendChild(folderTitle);
        header.addEventListener('click', (e) => {
            // Expand/collapse if clicking chevron or header (not pencil)
            if (
                e.target === chevron ||
                e.target === folderTitle ||
                e.currentTarget === e.target
            ) {
                folderSection.classList.toggle('collapsed');
                content.classList.toggle('collapsed');
                if (folderSection.classList.contains('collapsed')) {
                    chevron.classList.remove('fa-chevron-down');
                    chevron.classList.add('fa-chevron-right');
                } else {
                    chevron.classList.remove('fa-chevron-right');
                    chevron.classList.add('fa-chevron-down');
                }
            }
        });
        // Helper function to show the rename folder popup
        async function showRenameFolderPopup(folder) {
            const content = document.createElement('div');
            content.innerHTML = `<h3>Rename folder</h3>`;
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.value = folder.name;
            nameInput.style.width = '100%';
            nameInput.style.marginTop = '8px';
            nameInput.className = 'chatplus_menu_input';
            content.appendChild(nameInput);
            const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
                okButton: t`Rename`,
                cancelButton: t`Cancel`,
                wide: true
            });
            // Add Enter key support
            nameInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    popup.okButton.click(); // Trigger the popup's OK button
                }
            });
            const result = await popup.show();
            if ((result === POPUP_RESULT.AFFIRMATIVE) && nameInput.value.trim() && nameInput.value.trim() !== folder.name) {
                // Update folder name
                const folders = getFolders();
                const idx = folders.findIndex(f => f.id === folder.id);
                if (idx !== -1) {
                    folders[idx].name = nameInput.value.trim();
                    setFolders(folders);
                    await refreshFoldersTab();
                }
            }
        }

        // Helper function to show the add chats to folder popup
        async function showAddChatsToFolderPopup(folder) {
            const content = document.createElement('div');
            content.innerHTML = `<h3>Add Chats to "${folder.name}"</h3>`;
            content.style.width = '100%';
            content.style.maxHeight = '70vh';
            content.style.overflow = 'hidden';
            content.style.display = 'flex';
            content.style.flexDirection = 'column';

            // Add filter input
            const filterRow = document.createElement('div');
            filterRow.className = 'filter-row';
            filterRow.style.marginBottom = '10px';

            const inputWrapper = document.createElement('div');
            inputWrapper.className = 'filter-input-wrapper';
            inputWrapper.style.position = 'relative';
            inputWrapper.style.display = 'flex';
            inputWrapper.style.alignItems = 'center';

            const filterInput = document.createElement('input');
            filterInput.type = 'text';
            filterInput.placeholder = 'Filter chats...';
            filterInput.className = 'filter-input chatplus_menu_input';
            filterInput.style.paddingRight = '30px';
            filterInput.style.width = '100%';

            const clearButton = document.createElement('button');
            clearButton.className = 'filter-clear-button';
            clearButton.innerHTML = '<i class="fa-solid fa-xmark"></i>';
            clearButton.title = 'Clear filter';
            clearButton.style.position = 'absolute';
            clearButton.style.right = '5px';
            clearButton.style.background = 'none';
            clearButton.style.border = 'none';
            clearButton.style.cursor = 'pointer';
            clearButton.style.display = 'none';

            inputWrapper.appendChild(filterInput);
            inputWrapper.appendChild(clearButton);
            filterRow.appendChild(inputWrapper);
            content.appendChild(filterRow);

            // Add selection controls
            const selectionControls = document.createElement('div');
            selectionControls.style.display = 'flex';
            selectionControls.style.gap = '10px';
            selectionControls.style.marginBottom = '10px';
            selectionControls.style.alignItems = 'center';

            const selectedCount = document.createElement('span');
            selectedCount.style.marginLeft = 'auto';
            selectedCount.style.fontSize = '0.9em';
            selectedCount.style.color = '#888';
            selectedCount.textContent = '0 selected';

            selectionControls.appendChild(selectedCount);
            content.appendChild(selectionControls);

            // Chat list container
            const chatsContainer = document.createElement('div');
            chatsContainer.style.flex = '1 1 auto';
            chatsContainer.style.overflow = 'auto';
            chatsContainer.style.maxHeight = '50vh';
            chatsContainer.style.border = '1px solid #444';
            chatsContainer.style.borderRadius = '4px';
            chatsContainer.style.padding = '8px';
            content.appendChild(chatsContainer);

            // Loader
            const loader = document.createElement('div');
            loader.className = 'allChatsTabLoader';
            loader.style.textAlign = 'center';
            loader.style.padding = '20px';
            const loaderIcon = document.createElement('i');
            loaderIcon.className = 'fa-2x fa-solid fa-gear fa-spin';
            loader.appendChild(loaderIcon);
            chatsContainer.appendChild(loader);

            // Track selected chats
            const selectedChats = new Set();
            let allChatsData = [];

            // Function to render chat items with checkboxes
            function renderChatItemWithCheckbox(chat, container) {
                const chatItem = document.createElement('div');
                chatItem.className = 'tabItem tabItem-singleline bookmark-chat-item';
                chatItem.style.display = 'flex';
                chatItem.style.alignItems = 'center';
                chatItem.style.gap = '10px';
                chatItem.style.padding = '8px';
                chatItem.style.margin = '2px 0';
                chatItem.style.borderRadius = '4px';
                chatItem.style.cursor = 'pointer';
                chatItem.style.border = '1px solid transparent';

                // Checkbox
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.style.marginRight = '8px';
                const chatKey = `${chat.characterId}:${chat.file_name}`;
                checkbox.checked = selectedChats.has(chatKey);

                // Character/Group image
                let previewImg;
                if (chat.isGroup) {
                    previewImg = document.createElement('div');
                    previewImg.className = 'tabItem-previewImg group-preview';

                    const group = groups.find(g => g.id === chat.characterId);
                    if (group) {
                        let result = getGroupAvatar(group);
                        if (result && result.length > 0) {
                            const groupElement = result[0];
                            groupElement.style.width = '100%';
                            groupElement.style.height = '100%';
                            groupElement.style.minWidth = 'unset';
                            previewImg.appendChild(groupElement);
                        }
                    }
                } else {
                    previewImg = document.createElement('img');
                    previewImg.className = 'tabItem-previewImg';
                    previewImg.src = typeof getThumbnailUrl === 'function' ? getThumbnailUrl('avatar', chat.avatar) : (chat.avatar || '');
                    previewImg.alt = chat.character || '';
                }
                previewImg.style.width = '32px';
                previewImg.style.height = '32px';

                // Chat info
                const chatInfo = document.createElement('div');
                chatInfo.style.flex = '1 1 auto';
                chatInfo.style.overflow = 'hidden';

                const nameRow = document.createElement('div');
                nameRow.className = 'tabItem-nameRow';
                nameRow.textContent = `${chat.character}: ${chat.file_name}`;
                nameRow.style.whiteSpace = 'nowrap';
                nameRow.style.overflow = 'hidden';
                nameRow.style.textOverflow = 'ellipsis';

                const messageRow = document.createElement('div');
                messageRow.className = 'tabItem-message';
                messageRow.style.fontSize = '0.85em';
                messageRow.style.color = '#888';
                messageRow.style.whiteSpace = 'nowrap';
                messageRow.style.overflow = 'hidden';
                messageRow.style.textOverflow = 'ellipsis';
                messageRow.textContent = chat.stat && chat.stat.mes ? chat.stat.mes : 'No messages';

                chatInfo.appendChild(nameRow);
                chatInfo.appendChild(messageRow);

                chatItem.appendChild(checkbox);
                chatItem.appendChild(previewImg);
                chatItem.appendChild(chatInfo);

                // Click handling
                const toggleSelection = () => {
                    if (selectedChats.has(chatKey)) {
                        selectedChats.delete(chatKey);
                        checkbox.checked = false;
                        chatItem.style.backgroundColor = '';
                        chatItem.style.border = '1px solid transparent';
                    } else {
                        selectedChats.add(chatKey);
                        checkbox.checked = true;
                        chatItem.style.backgroundColor = 'rgba(100, 150, 255, 0.2)';
                        chatItem.style.border = '1px solid rgba(100, 150, 255, 0.5)';
                    }
                    updateSelectedCount();
                };

                chatItem.addEventListener('click', toggleSelection);
                checkbox.addEventListener('click', (e) => {
                    e.stopPropagation();
                    toggleSelection();
                });

                // Initial styling if selected
                if (selectedChats.has(chatKey)) {
                    chatItem.style.backgroundColor = 'rgba(100, 150, 255, 0.2)';
                    chatItem.style.border = '1px solid rgba(100, 150, 255, 0.5)';
                }

                container.appendChild(chatItem);
            }

            // Function to update selected count
            function updateSelectedCount() {
                selectedCount.textContent = `${selectedChats.size} selected`;
            }

            // Function to populate chats
            async function populateChats(filterValue = '') {
                loader.style.display = 'block';

                // Get all chats (similar to populateAllChatsTab)
                if (allChatsData.length === 0) {
                    const context = SillyTavern.getContext();
                    const characters = context.characters || {};

                    // Fetch all chat lists for all characters in parallel
                    const chatListPromises = Object.entries(characters).map(async ([charId, char]) => {
                        try {
                            const chats = await getListOfCharacterChats(char.avatar);
                            return chats.filter(chatName => typeof chatName === 'string' && chatName).map(chatName => ({
                                character: char.name || charId,
                                avatar: char.avatar,
                                file_name: chatName,
                                characterId: charId,
                                isGroup: false
                            }));
                        } catch (e) {
                            return [];
                        }
                    });
                    const chatLists = await Promise.all(chatListPromises);
                    let allChats = chatLists.flat();

                    // Add group chats
                    try {
                        const groupsResponse = await fetch('/api/groups/all', {
                            method: 'POST',
                            headers: getRequestHeaders(),
                        });
                        if (groupsResponse.ok) {
                            const groups = await groupsResponse.json();
                            const groupChatPromises = groups.map(async (group) => {
                                try {
                                    const chats = await getGroupPastChats(group.id);
                                    return chats.map(chat => {
                                        const fileName = typeof chat === 'string' ? chat.replace('.jsonl', '') : String(chat.file_name || chat).replace('.jsonl', '');
                                        return {
                                            character: group.name || `Group ${group.id}`,
                                            avatar: group.avatar || '',
                                            file_name: fileName,
                                            characterId: group.id,
                                            isGroup: true,
                                            groupMembers: group.members || []
                                        };
                                    });
                                } catch (e) {
                                    return [];
                                }
                            });

                            const groupChatLists = await Promise.all(groupChatPromises);
                            allChats = allChats.concat(groupChatLists.flat());
                        }
                    } catch (e) {
                        console.warn('Failed to load group chats in add to folder popup:', e);
                    }

                    // Fetch stats for both character and group chats
                    const uniqueCharacterIds = [...new Set(allChats.filter(chat => !chat.isGroup).map(chat => chat.characterId))];
                    const uniqueGroupIds = [...new Set(allChats.filter(chat => chat.isGroup).map(chat => chat.characterId))];

                    // Character stats
                    const characterStatsPromises = uniqueCharacterIds.map(async (charId) => {
                        try {
                            const statsList = await getPastCharacterChats(charId);
                            return statsList.map(stat => {
                                const fileName = String(stat.file_name).replace('.jsonl', '');
                                return [charId + ':' + fileName, stat];
                            });
                        } catch (e) {
                            return [];
                        }
                    });

                    // Group stats
                    const groupStatsPromises = uniqueGroupIds.map(async (groupId) => {
                        try {
                            const statsList = await getGroupPastChats(groupId);
                            return statsList.map(stat => {
                                const fileName = typeof stat === 'string' ? stat.replace('.jsonl', '') : String(stat.file_name || stat).replace('.jsonl', '');
                                return [groupId + ':' + fileName, stat];
                            });
                        } catch (e) {
                            return [];
                        }
                    });

                    const statsEntries = (await Promise.all([...characterStatsPromises, ...groupStatsPromises])).flat();
                    const chatStatsMap = Object.fromEntries(statsEntries);

                    allChatsData = allChats.map(chat => {
                        const stat = chatStatsMap[chat.characterId + ':' + chat.file_name];
                        let lastMesDate = null;
                        if (stat && stat.last_mes) {
                            const momentObj = timestampToMoment(stat.last_mes);
                            if (momentObj && momentObj.isValid()) {
                                lastMesDate = momentObj.toDate();
                            }
                        }
                        return { ...chat, stat, last_mes: lastMesDate };
                    }).filter(chat => chat.last_mes).sort((a, b) => b.last_mes - a.last_mes);
                }

                // Filter chats
                const filterLower = filterValue.toLowerCase();
                const filteredChats = allChatsData.filter(chat => {
                    if (!filterLower) return true;
                    return (
                        (chat.character && chat.character.toLowerCase().includes(filterLower)) ||
                        (chat.file_name && chat.file_name.toLowerCase().includes(filterLower)) ||
                        (chat.stat && chat.stat.mes && chat.stat.mes.toLowerCase().includes(filterLower))
                    );
                });

                // Clear container (except loader)
                const chatItems = chatsContainer.querySelectorAll('.bookmark-chat-item');
                chatItems.forEach(item => item.remove());

                // Render filtered chats
                filteredChats.forEach(chat => {
                    renderChatItemWithCheckbox(chat, chatsContainer);
                });

                loader.style.display = 'none';
                updateSelectedCount();
            }

            // Filter input handling
            filterInput.addEventListener('input', (e) => {
                const value = e.target.value.trim();
                populateChats(value);
                clearButton.style.display = value.length > 0 ? 'block' : 'none';
            });

            clearButton.addEventListener('click', () => {
                filterInput.value = '';
                clearButton.style.display = 'none';
                populateChats('');
                filterInput.focus();
            });

            // Initial population
            await populateChats();

            const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
                okButton: t`Add to Folder`,
                cancelButton: t`Cancel`,
                wide: true,
                large: true
            });

            const result = await popup.show();
            if (result === POPUP_RESULT.AFFIRMATIVE && selectedChats.size > 0) {
                // Add the selected chats to the folder
                let addedCount = 0;
                for (const chatKey of selectedChats) {
                    const [characterId, fileName] = chatKey.split(':', 2);
                    const chat = { characterId, file_name: fileName };

                    // Check if chat is already in the folder
                    const existingFolders = getChatFolderIds(chat);
                    if (!existingFolders.includes(folder.id)) {
                        assignChatToFolder(chat, folder.id);
                        addedCount++;
                    }
                }

                // Show success message
                const confirmContent = document.createElement('div');
                confirmContent.innerHTML = `<h3>Success!</h3><p>Added ${addedCount} chats to "${folder.name}".</p>`;
                if (addedCount !== selectedChats.size) {
                    const skipped = selectedChats.size - addedCount;
                    confirmContent.innerHTML += `<p><small>${skipped} chats were already in the folder.</small></p>`;
                }
                const confirmPopup = new Popup(confirmContent, POPUP_TYPE.TEXT, '', {
                    okButton: t`OK`
                });
                await confirmPopup.show();

                // Refresh the folders tab to show the updated folder contents
                await refreshFoldersTab();
            }
        }

        // Pencil icon click triggers rename popup
        pencilIcon.addEventListener('click', async (e) => {
            e.stopPropagation();
            await showRenameFolderPopup(folder);
        });

        // Bookmark icon for folder bookmarking
        const bookmarkBtn = document.createElement('button');
        bookmarkBtn.className = 'bookmarkFolderBtn pinBtn tabItem-pinBtn';
        bookmarkBtn.title = 'Add multiple chats to folder';
        bookmarkBtn.innerHTML = '<i class="fa-regular fa-bookmark"></i>';
        bookmarkBtn.onclick = async (e) => {
            e.stopPropagation();
            await showAddChatsToFolderPopup(folder);
        };
        header.appendChild(bookmarkBtn);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'removeFolderBtn';
        removeBtn.title = 'Remove folder';
        removeBtn.innerHTML = '<i class="fa-solid fa-xmark icon-grey"></i>';
        removeBtn.onclick = async (e) => {
            e.stopPropagation();
            // Folder preview for the remove confirmation popup
            const folderPreview = document.createElement('div');
            folderPreview.style.display = 'flex';
            folderPreview.style.alignItems = 'center';
            folderPreview.style.gap = '8px';
            folderPreview.style.margin = '8px 0 4px 0';
            folderPreview.style.fontWeight = 'bold';
            folderPreview.style.fontSize = '1em';
            const folderIcon = document.createElement('i');
            folderIcon.className = 'fa-solid fa-folder folder-title-icon';
            folderIcon.style.fontSize = '1.1em';
            folderPreview.appendChild(folderIcon);
            const folderName = document.createElement('span');
            folderName.textContent = folder ? folder.name : folder.id;
            folderPreview.appendChild(folderName);
            // Popup content
            const content = document.createElement('div');
            content.innerHTML = `<h3 style='margin-bottom:8px;'>${t`Remove this folder?`}</h3>`;
            content.appendChild(folderPreview);
            const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
                okButton: t`Remove`,
                cancelButton: t`Cancel`
            });
            const result = await popup.show();
            if (result === POPUP_RESULT.AFFIRMATIVE) {
                removeFolder(folder.id);
                await refreshFoldersTab();
            }
        };
        header.appendChild(removeBtn);
        folderSection.appendChild(header);
        const content = document.createElement('div');
        content.className = 'collapsible-content';
        folderSection.appendChild(content);
        let collapsed = false;
        try { collapsed = localStorage.getItem('topInfoBar_folder_collapsed_' + folder.id) === '1'; } catch { }
        if (collapsed) {
            folderSection.classList.add('collapsed');
            content.classList.add('collapsed');
            chevron.classList.remove('fa-chevron-down');
            chevron.classList.add('fa-chevron-right');
        }
        const chats = folderedChats[folder.id] || [];
        if (chats.length > 0) {
            for (const chat of chats) renderAllChatsTabItem(chat, content, false, folder.id);
        }
        container.appendChild(folderSection);
        // Render subfolders recursively inside content
        if (folder.children && folder.children.length > 0) {
            renderAllChatsFoldersUI(content, folderedChats, folder.children, level + 1);
        }
    });
}

/**
 * Render a single chat item in the Recent Chats tab.
 * @param {Object} chat - Chat object.
 * @param {HTMLElement} container - Container to append the item to.
 * @param {boolean} isPinned - Whether the chat is pinned.
 * @param {string|null} folderId - Folder ID if in a folder, else null.
 */
function renderAllChatsTabItem(chat, container, isPinned, folderId) {
    const stat = chat.stat;
    const tabItem = document.createElement('div');
    tabItem.classList.add('tabItem');
    if (isPinned) tabItem.classList.add('pinned');
    tabItem.classList.add('tabItem-root');

    // Character/Group image (character = img, group = div)
    // Check if this is a group chat
    const isGroup = chat.isGroup || false;
    let previewImg;
    if (isGroup) {
        previewImg = document.createElement('div');
        previewImg.className = 'tabItem-previewImg group-preview';

        // Find the actual group object using the chat's characterId (which is the group ID for group chats)
        const group = groups.find(g => g.id === chat.characterId);
        if (group) {
            // getGroupBlock returns a jQuery object, so we need to get the actual DOM element
            let result = getGroupAvatar(group);
            if (result && result.length > 0) {
                // Extract the actual DOM element from the jQuery object
                const groupElement = result[0];
                // Set required styles for consistent sizing
                groupElement.style.width = '100%';
                groupElement.style.height = '100%';
                groupElement.style.minWidth = 'unset';
                previewImg.appendChild(groupElement);
            }
        }
    } else {
        previewImg = document.createElement('img');
        previewImg.className = 'tabItem-previewImg';
        previewImg.src = typeof getThumbnailUrl === 'function' ? getThumbnailUrl('avatar', chat.avatar) : (chat.avatar || '');
        previewImg.alt = chat.character || '';
        previewImg.style.width = '32px';
        previewImg.style.height = '32px';
    }

    // Pencil icon for renaming chat
    const pencilIcon = document.createElement('i');
    pencilIcon.className = 'fa-solid fa-pencil-alt chat-rename-icon';
    pencilIcon.style.cursor = 'pointer';
    pencilIcon.style.margin = '0 6px 0 6px';
    pencilIcon.title = t`Rename chat`;
    pencilIcon.addEventListener('click', async (e) => {
        e.stopPropagation();
        // Show rename popup for chat
        const content = document.createElement('div');
        content.innerHTML = `<h3>${t`Rename chat`}</h3>`;
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = chat.file_name;
        nameInput.style.width = '100%';
        nameInput.style.marginTop = '8px';
        nameInput.className = 'chatplus_menu_input';
        content.appendChild(nameInput);
        const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
            okButton: t`Rename`,
            cancelButton: t`Cancel`,
            wide: true
        });
        nameInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                popup.okButton.click();
            }
        });
        const result = await popup.show();
        if ((result === POPUP_RESULT.AFFIRMATIVE) && nameInput.value.trim() && nameInput.value.trim() !== chat.file_name) {
            const context = SillyTavern.getContext();
            const loader = document.getElementById('extensionAllChatsTabLoader') || null;
            await renameGroupOrCharacterChat({
                characterId: chat.characterId,
                groupId: context.groupId,
                oldFileName: chat.file_name,
                newFileName: nameInput.value.trim(),
                loader
            });
            handleChatRename(chat, nameInput.value.trim());
            // Refresh UI after renaming
            if (typeof populateAllChatsTab === 'function') await populateAllChatsTab();
            if (typeof refreshFoldersTab === 'function') await refreshFoldersTab();
        }
    });

    const nameRow = document.createElement('div');
    nameRow.className = 'tabItem-nameRow';
    nameRow.textContent = `${chat.character}: ${chat.file_name}`;
    const pinBtn = document.createElement('button');
    pinBtn.className = 'pinBtn tabItem-pinBtn';
    if (folderId && folderId !== 'pinned') {
        pinBtn.title = t`Remove from folder`;
        pinBtn.innerHTML = `
            <span class="icon-slash-overlay">
                <i class="fa-solid fa-thumbtack"></i>
            </span>
        `;
    } else {
        pinBtn.title = isPinned ? t`Unpin chat` : t`Pin or folder chat`;
        pinBtn.innerHTML = isPinned
            ? `
                <span class="icon-slash-overlay">
                    <i class="fa-solid fa-thumbtack"></i>
                </span>
            `
            : '<i class="fa-regular fa-bookmark"></i>';
    }
    pinBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (folderId && folderId !== 'pinned') {
            // Show a preview in the remove confirmation popup 
            // Folder preview
            const folder = getFolders().find(f => f.id === folderId);
            const folderPreview = document.createElement('div');
            folderPreview.style.display = 'flex';
            folderPreview.style.alignItems = 'center';
            folderPreview.style.gap = '8px';
            folderPreview.style.margin = '8px 0 4px 0';
            folderPreview.style.fontWeight = 'bold';
            folderPreview.style.fontSize = '1em';
            const folderIcon = document.createElement('i');
            folderIcon.className = 'fa-solid fa-folder folder-title-icon';
            folderIcon.style.fontSize = '1.1em';
            folderPreview.appendChild(folderIcon);
            const folderName = document.createElement('span');
            folderName.textContent = folder ? folder.name : folderId;
            folderPreview.appendChild(folderName);
            // Chat preview
            const preview = document.createElement('div');
            preview.className = 'tabItem tabItem-singleline';
            preview.style.display = 'flex';
            preview.style.flexDirection = 'row';
            preview.style.alignItems = 'center';
            preview.style.gap = '10px';
            preview.style.margin = '8px 0 2px 0';

            // Character/Group image (character = img, group = div)
            const isGroup = chat.isGroup || false;
            let previewImg;
            if (isGroup) {
                previewImg = document.createElement('div');
                previewImg.className = 'tabItem-previewImg group-preview';

                const group = groups.find(g => g.id === chat.characterId);
                if (group) {
                    let result = getGroupAvatar(group);
                    if (result && result.length > 0) {
                        const groupElement = result[0];
                        groupElement.style.width = '100%';
                        groupElement.style.height = '100%';
                        groupElement.style.minWidth = 'unset';
                        previewImg.appendChild(groupElement);
                    }
                }
            } else {
                previewImg = document.createElement('img');
                previewImg.className = 'tabItem-previewImg';
                previewImg.src = typeof getThumbnailUrl === 'function' ? getThumbnailUrl('avatar', chat.avatar) : (chat.avatar || '');
                previewImg.alt = chat.character || '';
            }

            const nameRow = document.createElement('div');
            nameRow.className = 'tabItem-nameRow';
            nameRow.textContent = `${chat.character}: ${chat.file_name}`;
            preview.appendChild(previewImg);
            preview.appendChild(nameRow);
            // Popup content
            const content = document.createElement('div');
            content.innerHTML = `<h3 style='margin-bottom:8px;'>${t`Remove the chat from the folder?`}</h3>`;
            content.appendChild(folderPreview);
            content.appendChild(preview);
            // Use Popup constructor to allow DOM content
            const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
                okButton: t`Remove`,
                cancelButton: t`Cancel`
            });
            const result = await popup.show();
            if (result === POPUP_RESULT.AFFIRMATIVE) {
                removeChatFromFolder(chat, folderId);
                await refreshFoldersTab();
            }
            return;
        }
        if (isPinned) {
            // Show a preview in the unpin confirmation popup
            const preview = document.createElement('div');
            preview.className = 'tabItem tabItem-singleline';
            preview.style.display = 'flex';
            preview.style.flexDirection = 'row';
            preview.style.alignItems = 'center';
            preview.style.gap = '10px';
            preview.style.margin = '8px 0 2px 0';

            // Character/Group image (character = img, group = div)
            const isGroup = chat.isGroup || false;
            let previewImg;
            if (isGroup) {
                previewImg = document.createElement('div');
                previewImg.className = 'tabItem-previewImg group-preview';

                const group = groups.find(g => g.id === chat.characterId);
                if (group) {
                    let result = getGroupAvatar(group);
                    if (result && result.length > 0) {
                        const groupElement = result[0];
                        groupElement.style.width = '100%';
                        groupElement.style.height = '100%';
                        groupElement.style.minWidth = 'unset';
                        previewImg.appendChild(groupElement);
                    }
                }
            } else {
                previewImg = document.createElement('img');
                previewImg.className = 'tabItem-previewImg';
                previewImg.src = typeof getThumbnailUrl === 'function' ? getThumbnailUrl('avatar', chat.avatar) : (chat.avatar || '');
                previewImg.alt = chat.character || '';
            }

            const nameRow = document.createElement('div');
            nameRow.className = 'tabItem-nameRow';
            nameRow.textContent = `${chat.character}: ${chat.file_name}`;
            preview.appendChild(previewImg);
            preview.appendChild(nameRow);
            // Popup content
            const content = document.createElement('div');
            content.innerHTML = `<h3 style='margin-bottom:8px;'>${t`Unpin this chat?`}</h3>`;
            content.appendChild(preview);
            const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
                okButton: t`Unpin`,
                cancelButton: t`Cancel`
            });
            const result = await popup.show();
            if (result === POPUP_RESULT.AFFIRMATIVE) {
                togglePinChat(chat);
                await populateAllChatsTab();
                await refreshFoldersTab();
            }
            return;
        }
        const selectedFolderId = await promptSelectFolderOrPinned(chat);
        if (selectedFolderId === 'pinned') {
            togglePinChat(chat);
            await populateAllChatsTab();
            await refreshFoldersTab();
        } else if (selectedFolderId) {
            const folderIds = getChatFolderIds(chat);
            if (!folderIds.includes(selectedFolderId)) {
                assignChatToFolder(chat, selectedFolderId);
                await refreshFoldersTab();
            }
        }
    });
    if (isPinned || (folderId && folderId !== 'recent')) {
        tabItem.classList.add('tabItem-singleline');
        tabItem.style.display = 'flex';
        tabItem.style.flexDirection = 'row';
        tabItem.style.alignItems = 'center';
        tabItem.style.gap = '10px';
        nameRow.style.flex = '1 1 auto';
        nameRow.style.overflow = 'hidden';
        nameRow.style.textOverflow = 'ellipsis';
        nameRow.style.whiteSpace = 'nowrap';
        tabItem.appendChild(previewImg);
        tabItem.appendChild(nameRow);
        tabItem.appendChild(pinBtn);
        if (isPinned) {
            const rePinBtn = document.createElement('button');
            rePinBtn.className = 'pinBtn tabItem-pinBtn';
            rePinBtn.title = t`Pin or folder chat`;
            rePinBtn.innerHTML = '<i class="fa-regular fa-bookmark"></i>';
            rePinBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const selectedFolderId = await promptSelectFolderOrPinned(chat);
                if (selectedFolderId === 'pinned') return;
                else if (selectedFolderId) {
                    const folderIds = getChatFolderIds(chat);
                    if (!folderIds.includes(selectedFolderId)) {
                        assignChatToFolder(chat, selectedFolderId);
                        await refreshFoldersTab();
                    }
                    await populateAllChatsTab();
                }
            });
            tabItem.appendChild(rePinBtn);
        }
    } else {
        const infoContainer = document.createElement('div');
        infoContainer.className = 'tabItem-infoContainer';
        const nameRow = document.createElement('div');
        nameRow.className = 'tabItem-nameRow';
        nameRow.textContent = chat.isGroup
            ? `👥 ${chat.character}: ${chat.file_name}`
            : `${chat.character}: ${chat.file_name}`;
        const bottomRow = document.createElement('div');
        bottomRow.className = 'tabItem-bottomRow';
        // Pencil icon, first message, pin button (in this order)
        bottomRow.appendChild(pencilIcon);
        const chatMessage = document.createElement('div');
        chatMessage.classList.add('chatMessage', 'tabItem-message');
        chatMessage.textContent = stat && stat.mes ? stat.mes : '';
        chatMessage.title = stat && stat.mes ? stat.mes : '';
        bottomRow.appendChild(chatMessage);
        bottomRow.appendChild(pinBtn);
        infoContainer.appendChild(nameRow);
        infoContainer.appendChild(bottomRow);
        previewImg.classList.add('tabItem-img');
        tabItem.appendChild(previewImg);
        tabItem.appendChild(infoContainer);
    }
    container.appendChild(tabItem);
    tabItem.addEventListener('click', async (e) => {
        if (e.target.closest('.tabItem-pinBtn')) return;
        if (e.target.closest('.chat-rename-icon')) return;
        const context = SillyTavern.getContext();

        if (chat.isGroup) {
            // Handle group chat opening
            // First set the active group, then open the group chat
            const group = groups.find(g => g.id === chat.characterId);
            setActiveGroup(group);
            select_group_chats(group.id, true);
            await openChatById(chat.file_name, true, group.id);
        } else {
            // Existing character chat logic
            if (String(context.characterId) !== String(chat.characterId)) {
                await selectCharacterById(chat.characterId);
                await new Promise(resolve => setTimeout(resolve, 150));
            }
            await openChatById(chat.file_name);
        }
    });
}

// =========================
// 6. Extension Settings UI
// =========================
/**
 * Render the extension settings panel for ChatsPlus.
 * Adds an entry to the SillyTavern extensions menu.
 */
function renderExtensionSettings() {
    const context = SillyTavern.getContext();
    const settingsKey = MODULE_NAME;
    const settings = context.extensionSettings[settingsKey] ?? {};
    const EXTENSION_NAME = 'ChatsPlus';
    const settingsContainer = document.getElementById(`${settingsKey}-container`) ?? document.getElementById('extensions_settings2');
    if (!settingsContainer) return;
    if (settingsContainer.querySelector(`#${settingsKey}-drawer`)) return;
    // =========================
    // Extension Settings Drawer UI
    // =========================
    const inlineDrawer = document.createElement('div');
    inlineDrawer.id = `${settingsKey}-drawer`;
    inlineDrawer.classList.add('inline-drawer');
    settingsContainer.append(inlineDrawer);
    const inlineDrawerToggle = document.createElement('div');
    inlineDrawerToggle.classList.add('inline-drawer-toggle', 'inline-drawer-header');
    const extensionNameElement = document.createElement('b');
    extensionNameElement.textContent = EXTENSION_NAME;
    const inlineDrawerIcon = document.createElement('div');
    inlineDrawerIcon.classList.add('inline-drawer-icon', 'fa-solid', 'fa-circle-chevron-down', 'down');
    inlineDrawerToggle.append(extensionNameElement, inlineDrawerIcon);
    const inlineDrawerContent = document.createElement('div');
    inlineDrawerContent.classList.add('inline-drawer-content');
    inlineDrawerContent.innerHTML = `<p>Enable or disable the ChatsPlus extension.</p>`;
    // =========================
    // Enable/Disable Checkbox
    // =========================
    const enabledCheckboxLabel = document.createElement('label');
    enabledCheckboxLabel.classList.add('checkbox_label');
    enabledCheckboxLabel.htmlFor = `${settingsKey}-enabled`;
    const enabledCheckbox = document.createElement('input');
    enabledCheckbox.id = `${settingsKey}-enabled`;
    enabledCheckbox.type = 'checkbox';
    enabledCheckbox.checked = settings.enabled ?? true;
    enabledCheckbox.addEventListener('change', () => {
        settings.enabled = enabledCheckbox.checked;
        context.saveSettingsDebounced();
    });
    const enabledCheckboxText = document.createElement('span');
    enabledCheckboxText.textContent = t`Enable ChatsPlus (needs reload)`;
    enabledCheckboxLabel.append(enabledCheckbox, enabledCheckboxText);
    inlineDrawerContent.append(enabledCheckboxLabel);
    // =========================
    // Default Tab Selection UI
    // =========================
    const defaultTabSection = document.createElement('div');
    defaultTabSection.style.margin = '16px 0';
    defaultTabSection.innerHTML = `<b>${t`Default Tab on Startup:`}</b>`;
    const tabRow = document.createElement('div');
    tabRow.className = 'chatsplus-tabs-container';
    const tabOptions = [
        { label: t`Characters`, value: 'characters' },
        { label: t`Recent Chats`, value: 'recent' },
        { label: t`Folders`, value: 'folders' }
    ];
    let defaultTab = settings.defaultTab ?? 'characters';
    tabOptions.forEach(opt => {
        const btn = document.createElement('button');
        btn.textContent = opt.label;
        btn.className = 'chatsplus-tab';
        if (defaultTab === opt.value) btn.classList.add('active');
        btn.onclick = () => {
            defaultTab = opt.value;
            settings.defaultTab = defaultTab;
            context.saveSettingsDebounced();
            // Update button styles
            tabRow.querySelectorAll('button').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        };
        tabRow.appendChild(btn);
    });
    defaultTabSection.appendChild(tabRow);
    inlineDrawerContent.appendChild(defaultTabSection);

    // =========================
    // Backup Management Section
    // =========================
    const backupSection = document.createElement('div');
    backupSection.style.margin = '16px 0';
    backupSection.innerHTML = `<div><b>${t`Backup Management:`}</b></div>`;

    // Header for Import/Export section
    const importExportHeader = document.createElement('span');
    importExportHeader.textContent = t`Import/Export current extension data:`;
    backupSection.appendChild(importExportHeader);

    // Export/Import Buttons row at Bottom
    const exportImportRow = document.createElement('div');
    exportImportRow.style.display = 'flex';
    exportImportRow.style.gap = '10px';
    exportImportRow.style.margin = '8px 0';

    // Import Button
    const importBtn = document.createElement('button');
    importBtn.textContent = t`Import`;
    importBtn.className = 'settings-action-btn';
    importBtn.style.background = '#2a7';
    importBtn.style.color = '#fff';
    importBtn.style.border = 'none';
    importBtn.onclick = async () => {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.json,application/json';
        fileInput.style.display = 'none';
        fileInput.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                const imported = JSON.parse(text);
                if (typeof imported !== 'object' || Array.isArray(imported)) throw new Error('Invalid data');
                const content = document.createElement('div');
                content.innerHTML = `<h3 style='margin-bottom:8px;'>${t`Import ChatsPlus data?`}</h3><p>${t`This will overwrite your current ChatsPlus settings, folders, and pinned chats.`}</p>`;
                const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
                    okButton: t`Import`,
                    cancelButton: t`Cancel`
                });
                const result = await popup.show();
                if (result === POPUP_RESULT.AFFIRMATIVE) {
                    context.extensionSettings[settingsKey] = imported;
                    await context.saveSettingsDebounced();
                    alert(t`ChatsPlus data imported successfully!\nA reload is necessary to apply changes.`);
                }
            } catch (err) {
                alert(t`Failed to import: ` + err.message);
            }
        };
        document.body.appendChild(fileInput);
        fileInput.click();
        setTimeout(() => document.body.removeChild(fileInput), 5000);
    };
    // Export Button
    const exportBtn = document.createElement('button');
    exportBtn.textContent = t`Export`;
    exportBtn.className = 'settings-action-btn';
    exportBtn.style.background = '#27a';
    exportBtn.style.color = '#fff';
    exportBtn.style.border = 'none';
    exportBtn.onclick = () => {
        const data = JSON.stringify(context.extensionSettings[settingsKey] ?? {}, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'ChatsPlus-settings.json';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
    };
    // Append buttons to the row and drawer content
    exportImportRow.appendChild(importBtn);
    exportImportRow.appendChild(exportBtn);
    backupSection.appendChild(exportImportRow);

    inlineDrawerContent.appendChild(backupSection);

    // =========================
    // Manual Reload Section
    // =========================
    const reloadSection = document.createElement('div');
    reloadSection.style.margin = '16px 0';
    reloadSection.innerHTML = `<div><b>${t`Manual Reload:`}</b></div>`;

    const reloadDescription = document.createElement('p');
    reloadDescription.textContent = t`If the Recent Chats or Folders tabs become unresponsive, use this button to reload them.`;
    reloadDescription.style.fontSize = '0.9em';
    reloadDescription.style.color = '#888';
    reloadDescription.style.margin = '4px 0 8px 0';
    reloadSection.appendChild(reloadDescription);

    const reloadBtn = document.createElement('button');
    reloadBtn.textContent = t`Reload Tabs`;
    reloadBtn.className = 'settings-action-btn';
    reloadBtn.style.background = '#f39c12';
    reloadBtn.style.color = '#fff';
    reloadBtn.style.border = 'none';
    reloadBtn.style.padding = '8px 16px';
    reloadBtn.style.borderRadius = '4px';
    reloadBtn.style.cursor = 'pointer';
    reloadBtn.onclick = async () => {
        // Show loading state
        const originalText = reloadBtn.textContent;
        reloadBtn.textContent = t`Reloading...`;
        reloadBtn.disabled = true;

        try {
            // Clear the Recent Chats tab container to force a full reload
            const recentChatsContainer = getOrCreateRecentChatsTabContainer();
            if (recentChatsContainer) {
                recentChatsContainer.innerHTML = '';
                recentChatsTabContainer = null; // Reset the cached container
            }

            // Force refresh the Folders tab
            if (typeof refreshFoldersTab === 'function') {
                await refreshFoldersTab();
            }

            // If Recent Chats tab is currently active, reload it
            const recentChatsTab = document.getElementById('chatsplus-recent-chats-tab');
            const recentChatsButton = document.getElementById('chatsplus-recent-chats-tab-button');
            if (recentChatsTab && recentChatsTab.style.display !== 'none') {
                await renderAllChatsInRecentChatsTab();
            }

            // Show success feedback
            reloadBtn.textContent = t`Reloaded!`;
            reloadBtn.style.background = '#27ae60';
            setTimeout(() => {
                reloadBtn.textContent = originalText;
                reloadBtn.style.background = '#f39c12';
                reloadBtn.disabled = false;
            }, 2000);

        } catch (error) {
            console.error('Failed to reload tabs:', error);
            reloadBtn.textContent = t`Error - Try Again`;
            reloadBtn.style.background = '#e74c3c';
            setTimeout(() => {
                reloadBtn.textContent = originalText;
                reloadBtn.style.background = '#f39c12';
                reloadBtn.disabled = false;
            }, 3000);
        }
    };
    reloadSection.appendChild(reloadBtn);

    inlineDrawerContent.appendChild(reloadSection);
    inlineDrawer.append(inlineDrawerToggle, inlineDrawerContent);
    inlineDrawerToggle.addEventListener('click', function () {
        this.classList.toggle('open');
        inlineDrawerIcon.classList.toggle('down');
        inlineDrawerIcon.classList.toggle('up');
        inlineDrawerContent.classList.toggle('open');
    });
}

// =========================
// 7. Tab Management UI
// =========================
/**
 * Add the menu as a tab on the "Character Management" menu.
 * Sets up tab switching and folder tab refresh logic.
 */
function addTabToCharManagementMenu() {
    const menu = document.getElementById('right-nav-panel');
    if (!menu) return;
    if (menu.querySelector('#chatsplus-tab-row')) return;
    const charListButtonAndHotSwaps = menu.querySelector('#CharListButtonAndHotSwaps');
    const existingSiblings = [];
    let sibling = charListButtonAndHotSwaps ? charListButtonAndHotSwaps.nextElementSibling : null;
    while (sibling) {
        if (sibling.tagName !== 'HR') existingSiblings.push(sibling);
        sibling = sibling.nextElementSibling;
    }
    if (!charListButtonAndHotSwaps) return;
    const hr = document.createElement('hr');
    const tabRow = document.createElement('div');
    tabRow.id = 'chatsplus-tab-row';
    tabRow.className = 'chatsplus-tabs-container';
    const charactersTabButton = document.createElement('button');
    charactersTabButton.textContent = 'Characters';
    charactersTabButton.id = 'chatsplus-characters-tab-button';
    charactersTabButton.className = 'chatsplus-tab active';
    tabRow.appendChild(charactersTabButton);
    const recentChatsTabButton = document.createElement('button');
    recentChatsTabButton.id = 'chatsplus-recent-chats-tab-button';
    recentChatsTabButton.textContent = 'Recent Chats';
    recentChatsTabButton.className = 'chatsplus-tab';
    tabRow.appendChild(recentChatsTabButton);
    const foldersTabButton = document.createElement('button');
    foldersTabButton.id = 'chatsplus-folders-tab-button';
    foldersTabButton.textContent = 'Folders';
    foldersTabButton.className = 'chatsplus-tab';
    tabRow.appendChild(foldersTabButton);
    charListButtonAndHotSwaps.insertAdjacentElement('afterend', tabRow);

    // "Currently selected chat" element above the tab row
    const selectedChatWrapper = document.createElement('div');
    selectedChatWrapper.id = 'chatsplus-selected-chat-wrapper';
    selectedChatWrapper.style.margin = '8px 0 8px 0';
    // Add a header/title
    const selectedChatHeader = document.createElement('div');
    selectedChatHeader.id = 'chatsplus-selected-chat-header';
    selectedChatHeader.textContent = t ? t`Currently Selected Chat` : 'Currently Selected Chat';
    selectedChatHeader.style.fontWeight = 'bold';
    selectedChatHeader.style.fontSize = '1.08em';
    selectedChatHeader.style.marginBottom = '2px';
    selectedChatHeader.style.marginLeft = '2px';
    selectedChatWrapper.appendChild(selectedChatHeader);
    const selectedChatContainer = document.createElement('div');
    selectedChatContainer.id = 'chatsplus-selected-chat-container';
    selectedChatWrapper.appendChild(selectedChatContainer);
    tabRow.insertAdjacentElement('beforebegin', selectedChatWrapper);

    // Helper to render the currently selected chat
    function renderSelectedChat() {
        selectedChatContainer.innerHTML = '';
        const context = SillyTavern.getContext();
        let chatId = getCurrentChatId && getCurrentChatId();
        let charId = context.characterId;
        let groupId = context.groupId;
        let chat = null;

        // Check if we're in a group chat
        if (groupId && groups) {
            const group = groups.find(g => g.id === groupId);
            if (group) {
                chat = {
                    character: group.name || `Group ${groupId}`,
                    avatar: group.avatar || '',
                    file_name: chatId,
                    characterId: groupId,
                    isGroup: true
                };
            }
        } else if (context.characters && charId && context.characters[charId]) {
            const char = context.characters[charId];
            chat = {
                character: char.name || charId,
                avatar: char.avatar,
                file_name: chatId,
                characterId: charId,
                isGroup: false
            };
        }
        if (!chat || !chat.file_name) {
            selectedChatWrapper.style.display = 'none';
            return;
        }
        selectedChatWrapper.style.display = '';
        // Use the same rendering as .tabItem .tabItem-root
        const tabItem = document.createElement('div');
        tabItem.classList.add('tabItem', 'tabItem-root', 'tabItem-singleline');
        tabItem.style.display = 'flex';
        tabItem.style.flexDirection = 'row';
        tabItem.style.alignItems = 'center';
        tabItem.style.gap = '10px';
        tabItem.style.marginBottom = '2px';

        // Character/Group image (character = img, group = div)
        let previewImg;
        if (chat.isGroup) {
            previewImg = document.createElement('div');
            previewImg.className = 'tabItem-previewImg group-preview';

            const group = groups.find(g => g.id === chat.characterId);
            if (group) {
                let result = getGroupAvatar(group);
                if (result && result.length > 0) {
                    const groupElement = result[0];
                    groupElement.style.width = '100%';
                    groupElement.style.height = '100%';
                    groupElement.style.minWidth = 'unset';
                    previewImg.appendChild(groupElement);
                }
            }
        } else {
            previewImg = document.createElement('img');
            previewImg.className = 'tabItem-previewImg';
            previewImg.src = typeof getThumbnailUrl === 'function' ? getThumbnailUrl('avatar', chat.avatar) : (chat.avatar || '');
            previewImg.alt = chat.character || '';
        }
        const nameRow = document.createElement('div');
        nameRow.className = 'tabItem-nameRow';
        nameRow.textContent = `${chat.character}: ${chat.file_name}`;
        // Pencil icon for renaming chat 
        const pencilIcon = document.createElement('i');
        pencilIcon.className = 'fa-solid fa-pencil-alt chat-rename-icon';
        pencilIcon.style.cursor = 'pointer';
        pencilIcon.style.margin = '0 6px 0 6px';
        pencilIcon.title = t ? t`Rename chat` : 'Rename chat';
        pencilIcon.addEventListener('click', async (e) => {
            e.stopPropagation();
            // Show rename popup for chat
            const content = document.createElement('div');
            content.innerHTML = `<h3>${t ? t`Rename chat` : 'Rename chat'}</h3>`;
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.value = chat.file_name;
            nameInput.style.width = '100%';
            nameInput.style.marginTop = '8px';
            nameInput.className = 'chatplus_menu_input';
            content.appendChild(nameInput);
            const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
                okButton: t ? t`Rename` : 'Rename',
                cancelButton: t ? t`Cancel` : 'Cancel',
                wide: true
            });
            nameInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    popup.okButton.click();
                }
            });
            const result = await popup.show();
            if ((result === POPUP_RESULT.AFFIRMATIVE) && nameInput.value.trim() && nameInput.value.trim() !== chat.file_name) {
                const context = SillyTavern.getContext();
                const loader = document.getElementById('extensionAllChatsTabLoader') || null;
                await renameGroupOrCharacterChat({
                    characterId: chat.characterId,
                    groupId: context.groupId,
                    oldFileName: chat.file_name,
                    newFileName: nameInput.value.trim(),
                    loader
                });
                handleChatRename(chat, nameInput.value.trim());
                // Refresh UI after renaming
                if (typeof populateAllChatsTab === 'function') await populateAllChatsTab();
                if (typeof refreshFoldersTab === 'function') await refreshFoldersTab();
            }
        });

        // Pin button for pinning the "Currently Selected Chat" chat
        const pinBtn = document.createElement('button');
        pinBtn.className = 'pinBtn tabItem-pinBtn';
        pinBtn.title = (t ? t`Pin or folder chat` : 'Pin or folder chat');
        pinBtn.innerHTML = '<i class="fa-regular fa-bookmark"></i>';
        pinBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            // Show pin/folder selection popup
            const selectedFolderId = await promptSelectFolderOrPinned(chat);
            if (selectedFolderId === 'pinned') {
                togglePinChat(chat);
                // Refresh UI after pinning
                if (typeof populateAllChatsTab === 'function') await populateAllChatsTab();
                if (typeof refreshFoldersTab === 'function') await refreshFoldersTab();
                renderSelectedChat(); // Refresh the selected chat display
            } else if (selectedFolderId) {
                const folderIds = getChatFolderIds(chat);
                if (!folderIds.includes(selectedFolderId)) {
                    assignChatToFolder(chat, selectedFolderId);
                    // Refresh UI after assigning to folder
                    if (typeof populateAllChatsTab === 'function') await populateAllChatsTab();
                    if (typeof refreshFoldersTab === 'function') await refreshFoldersTab();
                }
            }
        });

        tabItem.appendChild(previewImg);
        tabItem.appendChild(nameRow);
        tabItem.appendChild(pencilIcon);
        tabItem.appendChild(pinBtn);
        selectedChatContainer.appendChild(tabItem);
    }
    // Make renderSelectedChat globally accessible for use in other functions
    window['chatsPlusRenderSelectedChat'] = renderSelectedChat;
    // Initial render
    renderSelectedChat();


    const tabsWrapper = document.createElement('div');
    tabsWrapper.id = 'chatsplus-tab-content-wrapper';
    tabsWrapper.className = 'chatsplus-tab-content';
    const charactersTab = document.createElement('div');
    charactersTab.id = 'chatsplus-characters-tab';
    charactersTab.style.display = '';
    tabsWrapper.appendChild(charactersTab);
    const recentChatsTab = document.createElement('div');
    recentChatsTab.id = 'chatsplus-recent-chats-tab';
    recentChatsTab.style.display = 'none';
    tabsWrapper.appendChild(recentChatsTab);
    const foldersTab = document.createElement('div');
    foldersTab.id = 'chatsplus-folders-tab';
    foldersTab.style.display = 'none';
    tabsWrapper.appendChild(foldersTab);
    existingSiblings.forEach(sibling => { charactersTab.appendChild(sibling); });
    activateTab = function (tabIdx) {
        charactersTabButton.classList.remove('active');
        recentChatsTabButton.classList.remove('active');
        foldersTabButton.classList.remove('active');
        charactersTab.style.display = 'none';
        recentChatsTab.style.display = 'none';
        foldersTab.style.display = 'none';
        if (tabIdx === 0) {
            charactersTabButton.classList.add('active');
            charactersTab.style.display = '';
        } else if (tabIdx === 1) {
            recentChatsTabButton.classList.add('active');
            recentChatsTab.style.display = '';
            renderAllChatsInRecentChatsTab();
        } else if (tabIdx === 2) {
            foldersTabButton.classList.add('active');
            foldersTab.style.display = '';
            const existingContainer = foldersTab.querySelector('.folders-tab-container');
            if (!existingContainer) {
                refreshFoldersTab(); // Note: not awaited to avoid blocking UI
            }
        }
    };
    charactersTabButton.addEventListener('click', () => activateTab(0));
    recentChatsTabButton.addEventListener('click', () => activateTab(1));
    foldersTabButton.addEventListener('click', () => activateTab(2));
    activateTab(2);
    menu.insertBefore(tabsWrapper, tabRow.nextSibling);
}

// =========================
// 7.1. Folders Tab Helper Functions
// =========================

/**
 * Build folderedChats map from chatFolders data and all available chats.
 * This function properly transforms the raw chatFolders data into the format
 * expected by renderAllChatsFoldersUI.
 * @param {Array} allChats - Array of all chat objects.
 * @returns {Object} Map of folderId to array of chats.
 */
function buildFolderedChatsMap(allChats) {
    const folderedChats = {};
    const chatFoldersMap = getChatFoldersMap();

    // Initialize empty arrays for all folders
    const folders = getFolders();
    folders.forEach(folder => {
        folderedChats[folder.id] = [];
    });

    // Process each chat and assign to folders
    allChats.forEach(chat => {
        const chatKey = chat.characterId + ':' + chat.file_name;
        const folderIds = chatFoldersMap[chatKey] || [];

        folderIds.forEach(folderId => {
            if (folderedChats[folderId]) {
                folderedChats[folderId].push(chat);
            }
        });
    });

    return folderedChats;
}

// =========================
// 7.2. Folders Tab Refresh Function
refreshFoldersTab = async function () {
    if (isRefreshingFoldersTab) {
        return;
    }
    isRefreshingFoldersTab = true;

    try {
        const foldersTab = document.getElementById('chatsplus-folders-tab');
        if (!foldersTab) {
            return;
        }

        // Check for existing containers before clearing
        const existingContainers = foldersTab.querySelectorAll('.folders-tab-container');

        foldersTab.innerHTML = '';
        const foldersTabContainer = document.createElement('div');
        foldersTabContainer.className = 'folders-tab-container';
        const addFolderRow = document.createElement('div');
        addFolderRow.className = 'add-folder-row';
        const addFolderBtn = document.createElement('button');
        addFolderBtn.className = 'add-folder-btn';
        addFolderBtn.title = 'Add Folder';
        addFolderBtn.innerHTML = '<i class="fa-solid fa-plus"></i>';
        addFolderBtn.addEventListener('click', async () => {
            // Show a popup with a list of all folders as radio inputs and allow selecting one (or none)
            // Recursively render radio buttons for folders
            function renderFolderRadios(nodes, radioName, container, level = 0) {
                nodes.forEach(folder => {
                    const label = document.createElement('label');
                    label.style.display = 'flex';
                    label.style.alignItems = 'center';
                    label.style.marginLeft = (level * 20) + 'px';
                    const radio = document.createElement('input');
                    radio.type = 'radio';
                    radio.name = radioName;
                    radio.value = folder.id;
                    label.appendChild(radio);
                    label.appendChild(document.createTextNode(' 📁 ' + folder.name));
                    container.appendChild(label);
                    if (folder.children && folder.children.length > 0) {
                        renderFolderRadios(folder.children, radioName, container, level + 1);
                    }
                });
            }
            const folders = getFolders().slice().sort((a, b) => a.name.localeCompare(b.name));
            const content = document.createElement('div');
            content.innerHTML = `<h3>${t`Select a parent folder (optional):`}</h3>`;
            const radioGroup = document.createElement('div');
            radioGroup.className = 'chatplus_radio_group';
            const radioName = 'parent-folder-radio';
            // Option for no parent
            const noneLabel = document.createElement('label');
            noneLabel.style.display = 'flex';
            noneLabel.style.alignItems = 'center';
            const noneRadio = document.createElement('input');
            noneRadio.type = 'radio';
            noneRadio.name = radioName;
            noneRadio.value = '';
            noneRadio.checked = true;
            noneLabel.appendChild(noneRadio);
            noneLabel.appendChild(document.createTextNode(' ' + t`No parent`));
            radioGroup.appendChild(noneLabel);
            // Render folder radios as tree
            const folderTree = buildFolderTree(folders);
            renderFolderRadios(folderTree, radioName, radioGroup, 0);
            content.appendChild(radioGroup);
            content.innerHTML += `<hr style='margin:10px 0;'>`;
            const nameLabel = document.createElement('label');
            nameLabel.textContent = t`Enter folder name:`;
            nameLabel.className = 'chatplus_menu_label';
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = 'chatplus_menu_input';
            content.appendChild(nameLabel);
            content.appendChild(nameInput);

            const popup = new Popup(
                content,
                POPUP_TYPE.TEXT,
                '',
                {
                    okButton: t`Add`,
                    cancelButton: t`Cancel`,
                    wide: true,
                    large: true,
                }
            );
            // Trigger the popup's OK button on Enter key
            nameInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    popup.okButton.click();
                }
            });        // Wait for popup result
            const popupResult = await popup.show();
            if (popupResult === POPUP_RESULT.CANCELLED) return null; // User cancelled the popup
            // Read the selected radio after popup closes
            const selectedRadio = content.querySelector('input[type="radio"]:checked');
            const selectedFolderId = selectedRadio && selectedRadio.value ? selectedRadio.value : null;
            const name = nameInput.value;
            if (name && name.trim()) {
                addFolder(name.trim(), selectedFolderId);
                await refreshFoldersTab();
            }
        });
        const addFolderLabel = document.createElement('span');
        addFolderLabel.className = 'add-folder-label';
        addFolderLabel.textContent = 'Add Folder';
        addFolderLabel.addEventListener('click', () => addFolderBtn.click());
        addFolderRow.appendChild(addFolderBtn);
        addFolderRow.appendChild(addFolderLabel);
        foldersTabContainer.appendChild(addFolderRow);
        let allChats = [];
        if (SillyTavern.getContext().characters) {
            const characters = SillyTavern.getContext().characters;
            // Parallelize fetching chat lists for all characters
            const chatListPromises = Object.entries(characters).map(async ([charId, char]) => {
                try {
                    const chats = await getListOfCharacterChats(char.avatar);
                    return chats.filter(chatName => typeof chatName === 'string' && chatName).map(chatName => ({
                        character: char.name || charId,
                        avatar: char.avatar,
                        file_name: chatName,
                        characterId: charId,
                        isGroup: false
                    }));
                } catch (e) {
                    return [];
                }
            });
            const chatLists = await Promise.all(chatListPromises);
            allChats = allChats.concat(chatLists.flat());
        }

        // Add group chats
        try {
            const groupsResponse = await fetch('/api/groups/all', {
                method: 'POST',
                headers: getRequestHeaders(),
            });
            if (groupsResponse.ok) {
                const groups = await groupsResponse.json();
                const groupChatPromises = groups.map(async (group) => {
                    try {
                        const chats = await getGroupPastChats(group.id);
                        return chats.map(chat => {
                            const fileName = typeof chat === 'string' ? chat.replace('.jsonl', '') : String(chat.file_name || chat).replace('.jsonl', '');
                            return {
                                character: group.name || `Group ${group.id}`,
                                avatar: group.avatar || '',
                                file_name: fileName,
                                characterId: group.id,
                                isGroup: true,
                                groupMembers: group.members || []
                            };
                        });
                    } catch (e) {
                        return [];
                    }
                });

                const groupChatLists = await Promise.all(groupChatPromises);
                allChats = allChats.concat(groupChatLists.flat());
            }
        } catch (e) {
            console.warn('Failed to load group chats in folders tab:', e);
        }

        let chatStatsMap = {};
        // Parallelize fetching stats for all characters and groups
        const uniqueCharacterIds = [...new Set(allChats.filter(chat => !chat.isGroup).map(chat => chat.characterId))];
        const uniqueGroupIds = [...new Set(allChats.filter(chat => chat.isGroup).map(chat => chat.characterId))];

        const characterStatsPromises = uniqueCharacterIds.map(async (charId) => {
            try {
                const statsList = await getPastCharacterChats(charId);
                return statsList.map(stat => {
                    const fileName = String(stat.file_name).replace('.jsonl', '');
                    return [charId + ':' + fileName, stat];
                });
            } catch (e) { return []; }
        });

        const groupStatsPromises = uniqueGroupIds.map(async (groupId) => {
            try {
                const statsList = await getGroupPastChats(groupId);
                return statsList.map(stat => {
                    const fileName = typeof stat === 'string' ? stat.replace('.jsonl', '') : String(stat.file_name || stat).replace('.jsonl', '');
                    return [groupId + ':' + fileName, stat];
                });
            } catch (e) { return []; }
        });

        const statsEntries = (await Promise.all([...characterStatsPromises, ...groupStatsPromises])).flat();
        chatStatsMap = Object.fromEntries(statsEntries);

        allChats = allChats.map(chat => {
            const stat = chatStatsMap[chat.characterId + ':' + chat.file_name];
            let lastMesRaw = stat && stat.last_mes ? stat.last_mes : null;
            let lastMesDate = null;
            if (lastMesRaw) {
                // Use timestampToMoment (dayjs wrapper) for robust parsing
                const momentObj = timestampToMoment(lastMesRaw);
                if (momentObj && momentObj.isValid()) {
                    lastMesDate = momentObj.toDate();
                }
            }
            return { ...chat, stat, last_mes: lastMesDate };
        });

        // Build the folderedChats map using the new helper function
        const folderedChats = buildFolderedChatsMap(allChats);
        renderAllChatsFoldersUI(foldersTabContainer, folderedChats);
        foldersTab.appendChild(foldersTabContainer);
    } finally {
        isRefreshingFoldersTab = false;
    }
};


// =========================
// 8. Initialization
// =========================

/**
 * Remove all backup files and clean up the obsolete backup system.
 * This function deletes all backup files from the server and clears localStorage.
 * This is a standalone function with all dependencies inlined.
 */
async function removeAllBackupFiles() {
    try {
        // Inlined constants and dependencies
        const BACKUP_STORAGE_KEY = 'chatsPlusBackupVersions';

        // Inlined getBackupVersions function
        let versions = [];
        try {
            versions = JSON.parse(localStorage.getItem(BACKUP_STORAGE_KEY) || '[]');
        } catch (error) {
            console.warn('Failed to parse backup versions from localStorage:', error);
            versions = [];
        }

        if (versions.length !== 0) {
            console.log(`ChatsPlus: Found ${versions.length} backup files to remove`);

            // Delete all backup files from server
            for (const backup of versions) {
                try {
                    const attachment = {
                        url: backup.url,
                        name: backup.fileName,
                        size: 0,
                        created: backup.created
                    };
                    await deleteAttachment(attachment, backup.source || 'global', () => { }, false);
                    console.log(`ChatsPlus: Deleted backup file: ${backup.fileName}`);
                } catch (error) {
                    console.warn(`ChatsPlus: Failed to delete backup file ${backup.fileName}:`, error);
                }
            }
        }

        // Clear all backup data from localStorage
        try {
            localStorage.removeItem(BACKUP_STORAGE_KEY);
        } catch (error) {
            console.warn('ChatsPlus: Failed to clear backup data from localStorage:', error);
        }
    } catch (error) {
        console.error('ChatsPlus: Failed to remove backup files:', error);
    }
}

/**
 * Initialize the extension: highlight, settings, and tab menu.
 * Adds event listeners for tab switching.
 */
(function initExtension() {
    const context = SillyTavern.getContext();
    const settingsKey = MODULE_NAME;
    const settings = context.extensionSettings[settingsKey] ?? {};
    renderExtensionSettings();

    // Enable/Disable the extension
    if (settings.enabled === false) return;

    // Initialize the extension
    addJQueryHighlight();

    // Remove obsolete backup system
    removeAllBackupFiles();

    // Listen for character management events that can shift character IDs
    if (eventSource && event_types) {
        if (event_types.CHARACTER_RENAMED) {
            eventSource.on(event_types.CHARACTER_RENAMED, handleCharacterRename);
        }

        if (event_types.CHARACTER_DELETED) {
            eventSource.on(event_types.CHARACTER_DELETED, handleCharacterDelete);
        }

        if (event_types.CHARACTER_DUPLICATED) {
            eventSource.on(event_types.CHARACTER_DUPLICATED, handleCharacterDuplicated);
        }

        // Settings events that rebuild character data
        if (event_types.SETTINGS_LOADED_AFTER) {
            eventSource.on(event_types.SETTINGS_LOADED_AFTER, handleSettingsReloaded);
        }

        // Character page events that might reload character data
        if (event_types.CHARACTER_PAGE_LOADED) {
            eventSource.on(event_types.CHARACTER_PAGE_LOADED, handleCharacterPageLoaded);
        }
    }
})();

/**
 * Update all internal references to a chat when its file_name is changed.
 * @param {Object} chat - The chat object being renamed.
 * @param {string} newName - The new file_name for the chat.
 */
function handleChatRename(chat, newName) {
    // Try to extract characterId from chat object
    let characterId = chat.characterId;
    if (!characterId) {
        const context = SillyTavern.getContext();
        if (context.characterId !== undefined) {
            characterId = context.characterId;
        } else if (context.groupId !== undefined) {
            characterId = context.groupId; // fallback for group chats
        }
    }
    if (!characterId) return;
    // Update pinnedChats
    let pinned = getPinnedChats();
    let changed = false;
    pinned = pinned.map(p => {
        if (p.file_name === chat.file_name && p.characterId === characterId) {
            changed = true;
            return { ...p, file_name: newName };
        }
        return p;
    });
    if (changed) setPinnedChats(pinned);
    // Update chatFolders
    let map = getChatFoldersMap();
    const oldKey = characterId + ':' + chat.file_name;
    const newKey = characterId + ':' + newName;
    if (map[oldKey]) {
        map[newKey] = map[oldKey];
        delete map[oldKey];
        setChatFoldersMap(map);
    }
}

/**
 * Process the character rename update after SillyTavern has rebuilt character data.
 * This function remaps ALL character references based on current avatar mappings.
 * @param {Object} renameData - Contains oldAvatar, newAvatar, and timestamp.
 */
async function processCharacterRenameUpdate(renameData) {
    const { oldAvatar, newAvatar } = renameData;

    const context = SillyTavern.getContext();
    const characters = context.characters;

    if (!characters) {
        return;
    }

    // Build a map of avatars to their current character IDs
    const avatarToCharacterId = {};
    for (const [charId, char] of Object.entries(characters)) {
        if (char.avatar) {
            avatarToCharacterId[char.avatar] = charId;
        }
    }

    // Build a comprehensive mapping of chat files to their correct character IDs
    // by actually checking which character has which chat files
    const chatFileToCharacterId = {};

    try {
        // Get all chat files for all characters to build accurate mapping
        for (const [charId, char] of Object.entries(characters)) {
            if (char.avatar) {
                try {
                    const chats = await getListOfCharacterChats(char.avatar);
                    if (Array.isArray(chats)) {
                        for (const chatName of chats) {
                            if (typeof chatName === 'string' && chatName) {
                                chatFileToCharacterId[chatName] = charId;
                            }
                        }
                    }
                } catch (e) {
                    // Continue with other characters if one fails
                }
            }
        }
    } catch (e) {
        // Continue with what we have
    }

    let updatesMade = false;

    // Update pinned chats - remap all character IDs based on actual chat ownership
    let pinned = getPinnedChats();
    let pinnedChanged = false;

    pinned = pinned.map(p => {
        // Try to find the correct character ID for this chat file
        const correctCharacterId = chatFileToCharacterId[p.file_name];

        if (correctCharacterId && correctCharacterId !== p.characterId) {
            pinnedChanged = true;
            updatesMade = true;
            return { ...p, characterId: correctCharacterId };
        } else if (!correctCharacterId) {
            // Chat file not found in any character, check if character ID is still valid
            const currentChar = characters[p.characterId];
            if (!currentChar) {
                // Keep the entry but it might be orphaned
            }
        }

        return p;
    });

    if (pinnedChanged) {
        setPinnedChats(pinned);
    }

    // Update chat folders - remap all character IDs based on actual chat ownership
    let map = getChatFoldersMap();
    let foldersChanged = false;
    const newMap = {};

    for (const [key, folderIds] of Object.entries(map)) {
        const [charId, fileName] = key.split(':', 2);

        // Try to find the correct character ID for this chat file
        const correctCharacterId = chatFileToCharacterId[fileName];

        if (correctCharacterId) {
            // We found the correct character for this chat file
            const correctKey = correctCharacterId + ':' + fileName;

            if (correctKey !== key) {
                foldersChanged = true;
                updatesMade = true;
            }

            newMap[correctKey] = folderIds;
        } else {
            // Chat file not found in any character, check if current character ID is still valid
            const currentChar = characters[charId];
            if (currentChar) {
                // Character still exists, keep the mapping
                newMap[key] = folderIds;
            } else {
                // Skip this entry as it's orphaned
            }
        }
    }

    if (foldersChanged) {
        setChatFoldersMap(newMap);
    }

    if (updatesMade) {
        // Refresh UI
        if (typeof refreshFoldersTab === 'function') {
            setTimeout(() => {
                refreshFoldersTab();
            }, 100);
        }

        if (typeof populateAllChatsTab === 'function') {
            setTimeout(() => {
                populateAllChatsTab();
            }, 100);
        }
    }
}

/**
 * Update all internal references when a character is renamed.
 * Since character IDs get reassigned during rename, we need to use avatar paths
 * as the stable identifier and defer the update to when character data is refreshed.
 * @param {string} oldAvatar - The old character avatar/identifier.
 * @param {string} newAvatar - The new character avatar/identifier.
 */
function handleCharacterRename(oldAvatar, newAvatar) {
    if (!oldAvatar || !newAvatar) {
        return;
    }

    // Store the rename mapping for delayed processing
    const renameData = { oldAvatar, newAvatar, timestamp: Date.now() };

    // Defer the actual update to allow SillyTavern to rebuild character data
    setTimeout(async () => {
        await processCharacterRenameUpdate(renameData);
    }, 500); // Give SillyTavern time to rebuild character data
}


/**
 * Handle character deletion - remove orphaned references.
 * @param {string} characterId - The ID of the deleted character.
 */
function handleCharacterDelete(characterId) {
    if (!characterId) return;

    setTimeout(async () => {
        let updatesMade = false;

        // Remove from pinned chats
        let pinned = getPinnedChats();
        const originalPinnedLength = pinned.length;
        pinned = pinned.filter(p => p.characterId !== characterId);
        if (pinned.length !== originalPinnedLength) {
            setPinnedChats(pinned);
            updatesMade = true;
        }

        // Remove from chat folders
        let map = getChatFoldersMap();
        const newMap = {};
        for (const [key, folderIds] of Object.entries(map)) {
            const [charId] = key.split(':', 1);
            if (charId !== characterId) {
                newMap[key] = folderIds;
            } else {
                updatesMade = true;
            }
        }
        setChatFoldersMap(newMap);

        if (updatesMade) {
            // Refresh UI
            if (typeof refreshFoldersTab === 'function') {
                setTimeout(() => refreshFoldersTab(), 100);
            }
            if (typeof populateAllChatsTab === 'function') {
                setTimeout(() => populateAllChatsTab(), 100);
            }
        }
    }, 100);
}

/**
 * Handle character duplication - character IDs may shift.
 */
function handleCharacterDuplicated() {
    // Defer the remapping to allow SillyTavern to rebuild character data
    setTimeout(async () => {
        await processCharacterRenameUpdate({
            oldAvatar: '',
            newAvatar: '',
            timestamp: Date.now()
        });
    }, 500);
}

/**
 * Handle settings reload - character IDs may be reassigned.
 */
function handleSettingsReloaded() {
    // Defer the remapping to allow SillyTavern to rebuild character data
    setTimeout(async () => {
        await processCharacterRenameUpdate({
            oldAvatar: '',
            newAvatar: '',
            timestamp: Date.now()
        });
    }, 1000); // Longer delay for settings reload
}

/**
 * Handle character page loaded - might indicate character data changes.
 */
function handleCharacterPageLoaded() {
    // Defer the remapping with a short delay
    setTimeout(async () => {
        await processCharacterRenameUpdate({
            oldAvatar: '',
            newAvatar: '',
            timestamp: Date.now()
        });
    }, 200);
}

// =========================
// Character Chat Modal Folder Integration
// =========================

// Hook into SillyTavern's chat modal to add folder view toggle
(() => {

    
    // Debouncing to prevent multiple calls
    let toggleTimeout = null;
    
    const debouncedAddToggle = () => {
        if (toggleTimeout) {
            clearTimeout(toggleTimeout);
        }
        toggleTimeout = setTimeout(() => {
            addCharacterFolderViewToggle();
        }, 300);
    };
    
    // Use MutationObserver to detect when chat modal appears
    const observeForChatModal = () => {
        const observer = new MutationObserver((mutations) => {
            let shouldAddToggle = false;
            
            mutations.forEach((mutation) => {
                if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
                    const target = mutation.target;
                    if (target.id === 'shadow_select_chat_popup') {
                        const displayStyle = target.style.display;
                        if (displayStyle === 'block' || displayStyle === '') {
                            shouldAddToggle = true;
                        }
                    }
                }
                
                // Also check for added nodes
                if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            if (node.id === 'shadow_select_chat_popup' || 
                                node.querySelector && node.querySelector('#shadow_select_chat_popup')) {
                                shouldAddToggle = true;
                            }
                        }
                    });
                }
            });
            
            // Only trigger once per batch of mutations
            if (shouldAddToggle) {
                debouncedAddToggle();
            }
        });
        
        // Start observing
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style']
        });
        

    };
    
    // Start observing when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', observeForChatModal);
    } else {
        observeForChatModal();
    }
    
    // Also try to add toggle if modal is already visible
    setTimeout(() => {
        const modal = document.getElementById('shadow_select_chat_popup');
        if (modal && modal.style.display === 'block') {
    
            addCharacterFolderViewToggle();
        }
    }, 1000);
})();

/**
 * Add folder view toggle to the character chat modal.
 */
function addCharacterFolderViewToggle() {
    const header = document.querySelector('div[name="selectChatPopupHeader"]');
    
    if (!header) {

        return;
    }
    
    // Check if toggle already exists
    if (document.getElementById('chatplus-character-view-toggle')) {
        return; // Silently return if toggle already exists
    }
    

    
    // Create view toggle container
    const toggleContainer = document.createElement('div');
    toggleContainer.id = 'chatplus-character-view-toggle';
    toggleContainer.style.cssText = `
        display: flex;
        gap: 5px;
        margin-top: 10px;
        align-items: center;
        justify-content: center;
        border: 1px solid #444;
        border-radius: 5px;
        background: rgba(0,0,0,0.3);
        padding: 5px;
    `;
    
    // List view button
    const listViewBtn = document.createElement('button');
    listViewBtn.className = 'menu_button';
    listViewBtn.innerHTML = '<i class="fa-solid fa-list"></i>&nbsp;&nbsp;List View';
    listViewBtn.style.cssText = 'flex: 1; margin: 0;';
    
    // Folder view button
    const folderViewBtn = document.createElement('button');
    folderViewBtn.className = 'menu_button';
    folderViewBtn.innerHTML = '<i class="fa-solid fa-folder"></i>&nbsp;&nbsp;Folder View';
    folderViewBtn.style.cssText = 'flex: 1; margin: 0;';
    
    // Get current view mode
    const currentMode = localStorage.getItem('chatplus_character_view_mode') || 'list';
    
    // Update button states
    const updateButtonStates = (mode) => {
        if (mode === 'folder') {
            folderViewBtn.style.backgroundColor = '#4a9eff';
            listViewBtn.style.backgroundColor = '';
        } else {
            listViewBtn.style.backgroundColor = '#4a9eff';
            folderViewBtn.style.backgroundColor = '';
        }
    };
    
    updateButtonStates(currentMode);
    
    // Add event listeners
    listViewBtn.addEventListener('click', async () => {
        localStorage.setItem('chatplus_character_view_mode', 'list');
        updateButtonStates('list');
        

        
        // Method 1: Try to call displayPastChats directly
        try {
            const context = SillyTavern?.getContext();
            if (context && typeof context.displayPastChats === 'function') {
    
                await context.displayPastChats();
                return; // Success, exit early
            }
        } catch (error) {
            console.warn('ChatPlus: context.displayPastChats failed, trying fallback:', error.message);
        }
        
        // Method 2: Try window.displayPastChats
        try {
            if (typeof window.displayPastChats === 'function') {
    
                await window.displayPastChats();
                return; // Success, exit early
            }
        } catch (error) {
            console.warn('ChatPlus: window.displayPastChats failed, using manual reconstruction:', error.message);
        }
        
        // Method 3: Manual reconstruction using fetch API
        
        const selectChatDiv = document.getElementById('select_chat_div');
        if (selectChatDiv) {
            selectChatDiv.innerHTML = '<div style="text-align: center; padding: 20px;">Loading list view...</div>';
            
            try {
                const currentCharacterId = getCurrentCharacterId();
                if (currentCharacterId) {
                    await renderListView(currentCharacterId);
                } else {
                    selectChatDiv.innerHTML = '<div style="text-align: center; padding: 20px; color: #888;">Could not load list view. Please refresh the page.</div>';
                }
            } catch (error) {
                console.error('ChatPlus: Manual list reconstruction failed:', error.message);
                selectChatDiv.innerHTML = '<div style="text-align: center; padding: 20px; color: #888;">Error loading list view. Please refresh the page.</div>';
            }
        }
    });
    
    folderViewBtn.addEventListener('click', async () => {
        localStorage.setItem('chatplus_character_view_mode', 'folder');
        updateButtonStates('folder');
        
        // Get current character ID - try multiple methods
        let currentCharacterId = getCurrentCharacterId();

        
        if (currentCharacterId !== undefined && currentCharacterId !== null) {
            await renderCharacterFolderView(currentCharacterId);
            // Re-add the toggle after refresh
            setTimeout(() => addCharacterFolderViewToggle(), 100);
        } else {

        }
    });
    
    toggleContainer.appendChild(listViewBtn);
    toggleContainer.appendChild(folderViewBtn);
    
    // Insert after the header
    header.parentNode.insertBefore(toggleContainer, header.nextSibling);
    

    
    // If we're already in folder mode, switch to it
    if (currentMode === 'folder') {
        const currentCharacterId = getCurrentCharacterId();
        if (currentCharacterId !== undefined && currentCharacterId !== null) {
            setTimeout(() => renderCharacterFolderView(currentCharacterId), 200);
        }
    }
}

/**
 * Render list view manually (fallback when displayPastChats doesn't work).
 * @param {string} characterId - Character ID.
 */
async function renderListView(characterId) {

    
    const selectChatDiv = document.getElementById('select_chat_div');
    if (!selectChatDiv) return;
    
    selectChatDiv.innerHTML = '';
    
    const context = SillyTavern.getContext();
    let characterChats = [];
    
    try {
        // Get character info
        let character = null;
        if (context?.characters) {
            if (Array.isArray(context.characters)) {
                const charIndex = parseInt(characterId);
                if (!isNaN(charIndex) && charIndex >= 0 && charIndex < context.characters.length) {
                    character = context.characters[charIndex];
                }
            } else {
                character = context.characters[characterId];
            }
        }
        
        if (character && character.avatar) {
    
            
            const response = await fetch('/api/chats/search', {
                method: 'POST',
                headers: context.getRequestHeaders(),
                body: JSON.stringify({
                    query: '',
                    avatar_url: character.avatar,
                    group_id: null,
                }),
            });
            
            if (response.ok) {
                characterChats = await response.json();
            
                
                // Sort chats by timestamp (most recent first)
                characterChats.sort((a, b) => {
                    const timeA = a.last_mes || 0;
                    const timeB = b.last_mes || 0;
                    return timeB - timeA;
                });
            }
        }
        
        // Render chats using original SillyTavern template style
        const currentChat = getCurrentChatName(); // Get current chat name if available
        
        characterChats.forEach(chat => {
            // Use same comparison logic as SillyTavern (with trimExtension)
            const isSelected = currentChat && trimChatExtension(currentChat) === trimChatExtension(chat.file_name);
            const chatElement = createListChatElement(chat, isSelected, character);
            selectChatDiv.appendChild(chatElement);
        });
        
    
        
    } catch (error) {
        console.error('ChatPlus: Error in renderListView:', error.message);
        selectChatDiv.innerHTML = `
            <div style="text-align: center; padding: 40px; color: #888;">
                <div style="font-size: 18px; margin-bottom: 10px;">❌ Error loading list view</div>
                <div>Failed to load chat data: ${error.message}</div>
            </div>
        `;
    }
}

/**
 * Create a chat element for list view (similar to original SillyTavern style).
 * @param {Object} chat - Chat object.
 * @param {boolean} isSelected - Whether this chat is currently selected.
 * @param {Object} character - Character object.
 * @returns {HTMLElement} Chat element.
 */
function createListChatElement(chat, isSelected, character) {
    const template = document.createElement('div');
    template.className = 'select_chat_block_wrapper flex-container';
    
    const chatBlock = document.createElement('div');
    chatBlock.className = 'select_chat_block wide100p flex-container';
    chatBlock.setAttribute('file_name', chat.file_name);
    
    if (isSelected) {
        chatBlock.setAttribute('highlight', String(true));
        
    }
    
    // Add click handler to load chat
    chatBlock.addEventListener('click', () => {

        
        // Try multiple ways to load the chat
        if (window.loadFileToChat) {
            window.loadFileToChat(chat.file_name);
        } else if (window.selectCharacterById) {
            // Use original SillyTavern method
            const event = new CustomEvent('chat_selected', { detail: { file_name: chat.file_name } });
            document.dispatchEvent(event);
        }
        
        // Close modal
        const modal = document.getElementById('shadow_select_chat_popup');
        if (modal) {
            modal.style.display = 'none';
        }
    });
    
    const nameWrapper = document.createElement('div');
    nameWrapper.id = 'select_chat_name_wrapper';
    nameWrapper.className = 'flex-container alignitemscenter justifySpaceBetween wide100p';
    
    const leftDiv = document.createElement('div');
    leftDiv.className = 'flex-container alignItemsCenter';
    
    const fileName = document.createElement('small');
    fileName.className = 'select_chat_block_filename select_chat_block_filename_item';
    fileName.textContent = chat.file_name;
    leftDiv.appendChild(fileName);
    
    // Add rename button (like original)
    const renameBtn = document.createElement('div');
    renameBtn.className = 'renameChatButton hoverglow opacity50p fa-solid fa-pencil fa-sm';
    renameBtn.title = 'Rename chat file';
    renameBtn.style.marginLeft = '8px';
    leftDiv.appendChild(renameBtn);
    
    nameWrapper.appendChild(leftDiv);
    
    const rightDiv = document.createElement('div');
    rightDiv.className = 'flex-container gap10px alignItemsCenter';
    
    // Chat info
    const chatInfo = document.createElement('div');
    chatInfo.className = 'select_chat_info flex-container';
    
    if (chat.last_mes) {
        const dateSpan = document.createElement('small');
        dateSpan.className = 'chat_messages_date select_chat_block_filename_item';
        dateSpan.textContent = new Date(chat.last_mes).toLocaleString();
        chatInfo.appendChild(dateSpan);
    }
    
    if (chat.file_size) {
        const sizeSpan = document.createElement('small');
        sizeSpan.className = 'chat_file_size select_chat_block_filename_item';
        sizeSpan.textContent = `(${chat.file_size},`;
        chatInfo.appendChild(sizeSpan);
    }
    
    if (chat.message_count) {
        const countSpan = document.createElement('small');
        countSpan.className = 'chat_messages_num select_chat_block_filename_item';
        countSpan.textContent = `${chat.message_count} 💬)`;
        chatInfo.appendChild(countSpan);
    }
    
    rightDiv.appendChild(chatInfo);
    
    // Add action buttons (export, delete, etc.)
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'flex-container gap10px';
    
    const exportBtn = document.createElement('div');
    exportBtn.className = 'exportRawChatButton opacity50p hoverglow fa-solid fa-file-export';
    exportBtn.title = 'Export JSONL chat file';
    exportBtn.setAttribute('data-format', 'jsonl');
    actionsDiv.appendChild(exportBtn);
    
    const exportTxtBtn = document.createElement('div');
    exportTxtBtn.className = 'exportChatButton opacity50p hoverglow fa-solid fa-file-lines';
    exportTxtBtn.title = 'Download chat as plain text document';
    exportTxtBtn.setAttribute('data-format', 'txt');
    actionsDiv.appendChild(exportTxtBtn);
    
    const deleteBtn = document.createElement('div');
    deleteBtn.className = 'PastChat_cross opacity50p hoverglow fa-solid fa-skull';
    deleteBtn.title = 'Delete chat file';
    deleteBtn.setAttribute('file_name', chat.file_name);
    actionsDiv.appendChild(deleteBtn);
    
    rightDiv.appendChild(actionsDiv);
    nameWrapper.appendChild(rightDiv);
    
    chatBlock.appendChild(nameWrapper);
    
    // Preview message
    if (chat.preview_message) {
        const previewDiv = document.createElement('div');
        previewDiv.className = 'select_chat_block_mes';
        previewDiv.textContent = chat.preview_message;
        chatBlock.appendChild(previewDiv);
    }
    
    template.appendChild(chatBlock);
    return template;
}

/**
 * Get current chat name (using SillyTavern's method).
 * @returns {string|null} Current chat file name.
 */
function getCurrentChatName() {
    try {
        const context = SillyTavern?.getContext();
        if (!context) {
    
            return null;
        }
        
        // Debug info (can be removed in production)
    
        
        // Try multiple methods to get current chat name
        let currentChatName = null;
        
        // Method 1: SillyTavern's getCurrentChatDetails logic
        if (context.selected_group) {
            const group = context.groups?.find(x => x.id === context.selected_group);
            currentChatName = group?.chat_id || null;
            // Found group chat via context
        } else if (context.characters && context.this_chid !== undefined) {
            currentChatName = context.characters[context.this_chid]?.chat || null;
            // Found character chat via context
        }
        
        // Method 2: Try SillyTavern's chat ID functions and properties
        if (!currentChatName) {
            // Try getCurrentChatId function first
            if (typeof context.getCurrentChatId === 'function') {
                try {
                    currentChatName = context.getCurrentChatId();
                    // Found current chat via getCurrentChatId()
                } catch (e) {
                    // getCurrentChatId() not available
                }
            }
            
            // Try chatId property
            if (!currentChatName && context.chatId) {
                currentChatName = context.chatId;
                // Found via chatId property
            }
            
            // Try other direct properties (exclude context.chat as it's message array)
            if (!currentChatName) {
                currentChatName = context.currentChatName || context.chat_name || context.sessionName || null;
                // Found via other properties
            }
        }
        
        // Method 3: Try chat_metadata
        if (!currentChatName && context.chat_metadata) {
            currentChatName = context.chat_metadata.chat_name || context.chat_metadata.sessionName || null;
            // Found via chat_metadata
        }
        
        // Method 4: Try global window variables
        if (!currentChatName) {
            try {
                // Try global chatId or chat_name first
                if (window.chatId) {
                    currentChatName = window.chatId;
                } else if (window.chat_name) {
                    currentChatName = window.chat_name;
                }
                
                if (!currentChatName && window.selected_group && window.groups) {
                    const group = window.groups.find(x => x.id === window.selected_group);
                    currentChatName = group?.chat_id || null;
                } else if (!currentChatName && window.this_chid !== undefined && window.characters) {
                    const char = Array.isArray(window.characters) ? 
                        window.characters[window.this_chid] : 
                        window.characters[window.this_chid];
                    currentChatName = char?.chat || null;
                }
            } catch (e) {
                // Global variables not available
            }
        }
        
        // Method 5: Try to get from DOM (last resort)
        if (!currentChatName) {
            try {
                // Check if there's a chat currently loaded in the UI
                const chatDisplay = document.querySelector('#chat_name, .chat_name, [data-chat-name]');
                if (chatDisplay) {
                    currentChatName = chatDisplay.textContent || chatDisplay.getAttribute('data-chat-name');
                    // Found via DOM extraction
                }
            } catch (e) {
                // DOM extraction not available
            }
        }
        
        // Debug: currentChatName found or not (can be removed in production)
    
        
        return currentChatName;
    } catch (error) {
        console.error('ChatPlus: Error getting current chat name:', error.message);
        return null;
    }
}

/**
 * Trim file extension for comparison (same as SillyTavern).
 * @param {string} fileName - File name to trim.
 * @returns {string} Trimmed file name.
 */
function trimChatExtension(fileName) {
    return String(fileName).replace('.jsonl', '');
}

/**
 * Get the current character ID using the working method.
 * @returns {string|undefined} The current character ID.
 */
function getCurrentCharacterId() {
    try {
        const context = SillyTavern?.getContext();
        if (!context) {
    
            return undefined;
        }
        
        // The working method: check context.characterId for array-based characters
        if (context.characterId !== undefined && context.characterId !== null) {
    
            return context.characterId.toString();
        }
        
        // Fallback for older SillyTavern versions with this_chid
        if (context.this_chid !== undefined && context.this_chid !== null) {
    
            return context.this_chid.toString();
        }
        
        // Group chat support
        if (context.selected_group !== undefined && context.selected_group !== null) {
    
            return 'group_' + context.selected_group;
        }
        
    
        return undefined;
        
    } catch (error) {
        console.error('ChatPlus: Error getting character ID:', error.message);
        return undefined;
    }
}

// ============================================
// Character Statistics Feature (Heart Icon)
// ============================================

/**
 * Initialize the character statistics feature.
 * Adds a heart icon to the character menu that shows statistics modal.
 */
function initCharacterStatistics() {
    // Observer to detect when character menu appears
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.type === 'childList') {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        // Check if the character form buttons block is now visible
                        const targetContainer = document.querySelector('.form_create_bottom_buttons_block');
                        if (targetContainer && !targetContainer.querySelector('.chatplus-heart-stats-icon')) {
                            addHeartIconToCharacterMenu(targetContainer);
                        }
                    }
                });
            }
        });
    });
    
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });
    
    // Also try to add immediately if already visible
    setTimeout(() => {
        const targetContainer = document.querySelector('.form_create_bottom_buttons_block');
        if (targetContainer && !targetContainer.querySelector('.chatplus-heart-stats-icon')) {
            addHeartIconToCharacterMenu(targetContainer);
        }
    }, 1000);
}

/**
 * Add heart icon to the character menu.
 * @param {HTMLElement} container - The container to add the icon to.
 */
function addHeartIconToCharacterMenu(container) {
    const heartIcon = document.createElement('div');
    heartIcon.className = 'menu_button fa-solid fa-heart interactable chatplus-heart-stats-icon';
    heartIcon.title = 'Character Statistics';
    heartIcon.style.cssText = 'color: #ff6b9d;';
    
    heartIcon.addEventListener('click', async (e) => {
        e.stopPropagation();
        await showCharacterStatisticsModal();
    });
    
    // Prepend to the container (leftmost position)
    container.prepend(heartIcon);
}

/**
 * Add custom scrollbar styles for Character Statistics modal.
 */
function addCharacterStatsScrollbarStyles() {
    if (!document.getElementById('chatplus-stats-scrollbar-style')) {
        const style = document.createElement('style');
        style.id = 'chatplus-stats-scrollbar-style';
        style.textContent = `
            #chatplus-stats-content::-webkit-scrollbar,
            #chatplus-analysis-result::-webkit-scrollbar {
                width: 8px;
            }
            #chatplus-stats-content::-webkit-scrollbar-track,
            #chatplus-analysis-result::-webkit-scrollbar-track {
                background: rgba(255, 255, 255, 0.1);
                border-radius: 4px;
            }
            #chatplus-stats-content::-webkit-scrollbar-thumb,
            #chatplus-analysis-result::-webkit-scrollbar-thumb {
                background: rgba(138, 180, 248, 0.5);
                border-radius: 4px;
            }
            #chatplus-stats-content::-webkit-scrollbar-thumb:hover,
            #chatplus-analysis-result::-webkit-scrollbar-thumb:hover {
                background: rgba(138, 180, 248, 0.7);
            }
        `;
        document.head.appendChild(style);
    }
}

/**
 * Show the character statistics modal.
 */
async function showCharacterStatisticsModal() {
    // Add scrollbar styles
    addCharacterStatsScrollbarStyles();
    
    const characterId = getCurrentCharacterId();
    
    if (!characterId || characterId.startsWith('group_')) {
        toastr.warning('Please select a character first (not a group).');
        return;
    }
    
    const context = SillyTavern.getContext();
    let character = null;
    
    // Get character info
    if (context?.characters) {
        if (Array.isArray(context.characters)) {
            const charIndex = parseInt(characterId);
            if (!isNaN(charIndex) && charIndex >= 0 && charIndex < context.characters.length) {
                character = context.characters[charIndex];
            }
        } else {
            character = context.characters[characterId];
        }
    }
    
    if (!character) {
        toastr.error('Could not find character information.');
        return;
    }
    
    const characterName = character.name || 'Unknown';
    
    // Create modal content with loading state
    const content = document.createElement('div');
    content.innerHTML = `
        <h3 style="margin-bottom: 20px; display: flex; align-items: center; gap: 10px;">
            <i class="fa-solid fa-heart" style="color: #ff6b9d;"></i>
            ${characterName}
        </h3>
        <div id="chatplus-stats-content" style="
            min-height: 150px;
            max-height: 70vh;
            overflow-y: auto;
            overflow-x: hidden;
            display: flex;
            align-items: center;
            justify-content: center;
            scrollbar-width: thin;
            scrollbar-color: rgba(138, 180, 248, 0.5) rgba(255, 255, 255, 0.1);
        ">
            <div style="text-align: center;">
                <i class="fa-solid fa-spinner fa-spin" style="font-size: 32px; color: #4a9eff;"></i>
                <div style="margin-top: 10px; color: #888;">Loading statistics...</div>
            </div>
        </div>
    `;
    
    // Show popup immediately with loading state
    const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
        okButton: t`Close`,
        wide: true,
        large: true
    });
    
    // Start loading data in background
    loadCharacterStatistics(characterId, character).then(stats => {
        const statsContent = document.getElementById('chatplus-stats-content');
        if (statsContent) {
            // Reset flex styles to allow proper scrolling
            statsContent.style.display = 'block';
            statsContent.style.alignItems = 'unset';
            statsContent.style.justifyContent = 'unset';
            statsContent.innerHTML = formatStatisticsHTML(stats, character, characterId);
        }
    }).catch(error => {
        console.error('ChatPlus: Error loading statistics:', error);
        const statsContent = document.getElementById('chatplus-stats-content');
        if (statsContent) {
            statsContent.innerHTML = `
                <div style="text-align: center; color: #ff6b6b;">
                    <i class="fa-solid fa-exclamation-triangle" style="font-size: 32px;"></i>
                    <div style="margin-top: 10px;">Failed to load statistics.</div>
                </div>
            `;
        }
    });
    
    await popup.show();
}

/**
 * Extract date from SillyTavern date string formats.
 * Supports multiple formats:
 * - "YYYY-MM-DD@HHhMMmSSs" (standard format)
 * - "March 10, 2024 5:24pm" (send_date format)
 * - "2024-3-10 @17h 24m 32s 442ms" (old create_date format)
 * @param {string} dateString - The date string to parse.
 * @returns {Date|null} Parsed Date object or null if invalid.
 */
function extractDateFromSTFormat(dateString) {
    if (!dateString) return null;
    
    // Format 1: YYYY-MM-DD@HHhMMmSSs
    let match = dateString.match(/(\d{4})-(\d{1,2})-(\d{1,2})@(\d{2})h(\d{2})m(\d{2})s/);
    if (match) {
        const [, year, month, day, hours, minutes, seconds] = match;
        const date = new Date(
            parseInt(year), 
            parseInt(month) - 1,
            parseInt(day), 
            parseInt(hours), 
            parseInt(minutes), 
            parseInt(seconds)
        );
        
        if (!isNaN(date.getTime())) {
            const year = date.getFullYear();
            if (year >= 2000 && year <= 2100) {
                return date;
            }
        }
    }
    
    // Format 2: "March 10, 2024 5:24pm" or similar natural language dates
    // Use native Date parsing
    try {
        const date = new Date(dateString);
        if (!isNaN(date.getTime())) {
            const year = date.getFullYear();
            if (year >= 2000 && year <= 2100) {
                return date;
            }
        }
    } catch (e) {
        // Continue to next format
    }
    
    // Format 3: "2024-3-10 @17h 24m 32s 442ms" (old format with spaces)
    match = dateString.match(/(\d{4})-(\d{1,2})-(\d{1,2})\s*@(\d{1,2})h\s*(\d{1,2})m\s*(\d{1,2})s/);
    if (match) {
        const [, year, month, day, hours, minutes, seconds] = match;
        const date = new Date(
            parseInt(year), 
            parseInt(month) - 1,
            parseInt(day), 
            parseInt(hours), 
            parseInt(minutes), 
            parseInt(seconds)
        );
        
        if (!isNaN(date.getTime())) {
            const year = date.getFullYear();
            if (year >= 2000 && year <= 2100) {
                return date;
            }
        }
    }
    
    return null;
}

/**
 * Fetch create_date from a chat file's content.
 * @param {Object} character - Character object.
 * @param {string} fileName - Chat file name.
 * @param {Object} context - SillyTavern context.
 * @returns {Promise<Date|null>} The create date or null.
 */
async function fetchChatCreateDateFromFile(character, fileName, context) {
    try {
        // API automatically adds .jsonl, so remove it if present
        const fileNameWithoutExt = fileName.replace('.jsonl', '');
        
        const response = await fetch('/api/chats/get', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({
                ch_name: character.avatar.replace('.png', ''),
                file_name: fileNameWithoutExt,
                avatar_url: character.avatar
            }),
        });
        
        if (response.ok) {
            const chatContent = await response.json();
            
            // JSONL files are returned as array of message objects
            if (chatContent && Array.isArray(chatContent) && chatContent.length > 0) {
                // Try to find the earliest date from first few messages
                let earliestDate = null;
                
                // Check first 3 messages for create_date or send_date
                for (let i = 0; i < Math.min(3, chatContent.length); i++) {
                    const message = chatContent[i];
                    
                    // Try create_date first
                    if (message.create_date) {
                        const date = extractDateFromSTFormat(message.create_date);
                        if (date && (!earliestDate || date < earliestDate)) {
                            earliestDate = date;
                        }
                    }
                    
                    // Try send_date as fallback
                    if (message.send_date) {
                        const date = extractDateFromSTFormat(message.send_date);
                        if (date && (!earliestDate || date < earliestDate)) {
                            earliestDate = date;
                        }
                    }
                }
                
                if (earliestDate) {
                    return earliestDate;
                }
            }
        }
    } catch (e) {
        // Silent failure - file might not exist or be inaccessible
    }
    return null;
}

/**
 * Load character statistics from chat files.
 * This implementation uses a hybrid approach:
 * 1. Try to extract dates from file names (fast)
 * 2. For files without parseable names, read the file content (slower but accurate)
 * @param {string} characterId - Character ID.
 * @param {Object} character - Character object.
 * @returns {Promise<Object>} Statistics object with firstMeeting, daysTogether, totalChats, totalMessages.
 */
async function loadCharacterStatistics(characterId, character) {
    const context = SillyTavern.getContext();
    let characterChats = [];
    
    // Fetch all chats for this character
    if (character && character.avatar) {
        const response = await fetch('/api/chats/search', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({
                query: '',
                avatar_url: character.avatar,
                group_id: null,
            }),
        });
        
        if (response.ok) {
            characterChats = await response.json();
        }
    }
    
    if (characterChats.length === 0) {
        return {
            firstMeeting: null,
            daysTogether: 0,
            totalChats: 0,
            totalMessages: 0
        };
    }
    
    // HYBRID ALGORITHM: Extract dates from file names AND read files when needed
    let earliestDate = null;
    let totalMessages = 0;
    let datesFound = [];
    let filesNeedingRead = [];
    
    // Step 1: Try to extract dates from all file names
    characterChats.forEach(chat => {
        // Sum up messages
        if (chat.message_count) {
            totalMessages += parseInt(chat.message_count) || 0;
        } else if (chat.mes) {
            totalMessages += parseInt(chat.mes) || 0;
        }
        
        // Try to extract date from file name
        const fileDate = extractDateFromSTFormat(chat.file_name);
        if (fileDate) {
            datesFound.push({
                file: chat.file_name,
                date: fileDate,
                source: 'filename'
            });
            
            if (!earliestDate || fileDate < earliestDate) {
                earliestDate = fileDate;
            }
        } else {
            // Cannot parse from filename, need to read file
            filesNeedingRead.push(chat);
        }
    });
    
    // Step 2: Read files that couldn't be parsed from filename
    // Read ALL files to ensure we find the earliest date
    if (filesNeedingRead.length > 0) {
        for (const chat of filesNeedingRead) {
            const fileDate = await fetchChatCreateDateFromFile(character, chat.file_name, context);
            if (fileDate) {
                datesFound.push({
                    file: chat.file_name,
                    date: fileDate,
                    source: 'file_content'
                });
                
                if (!earliestDate || fileDate < earliestDate) {
                    earliestDate = fileDate;
                }
            }
        }
    }
    
    // Calculate days together
    let daysTogether = 0;
    if (earliestDate && !isNaN(earliestDate.getTime())) {
        const today = new Date();
        const diffTime = Math.abs(today - earliestDate);
        daysTogether = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    }
    
    return {
        firstMeeting: earliestDate,
        daysTogether: daysTogether,
        totalChats: characterChats.length,
        totalMessages: totalMessages
    };
}

/**
 * Format days into years, months, days string.
 * @param {number} totalDays - Total number of days.
 * @returns {string} Formatted string (e.g., "1년 2개월 15일").
 */
function formatDaysToPeriod(totalDays) {
    const years = Math.floor(totalDays / 365);
    const remainingDaysAfterYears = totalDays % 365;
    const months = Math.floor(remainingDaysAfterYears / 30);
    const days = remainingDaysAfterYears % 30;
    
    const parts = [];
    if (years > 0) parts.push(`${years}년`);
    if (months > 0) parts.push(`${months}개월`);
    if (days > 0 || parts.length === 0) parts.push(`${days}일`);
    
    return parts.join(' ');
}

/**
 * Format statistics into HTML.
 * @param {Object} stats - Statistics object.
 * @param {Object} character - Character object.
 * @param {string} characterId - Character ID.
 * @returns {string} HTML string.
 */
function formatStatisticsHTML(stats, character, characterId) {
    let firstMeetingStr = '기록 없음';
    if (stats.firstMeeting && stats.firstMeeting instanceof Date && !isNaN(stats.firstMeeting.getTime())) {
        try {
            firstMeetingStr = stats.firstMeeting.toLocaleDateString('ko-KR', { 
                year: 'numeric', 
                month: 'long', 
                day: 'numeric' 
            });
        } catch (e) {
            firstMeetingStr = stats.firstMeeting.toISOString().split('T')[0];
        }
    }
    
    const daysTogetherStr = stats.daysTogether > 0
        ? `${stats.daysTogether}일 (${formatDaysToPeriod(stats.daysTogether)})`
        : '오늘 처음';
    
    return `
        <div style="
            display: flex;
            flex-direction: column;
            gap: 16px;
            padding: 10px;
            width: 100%;
            box-sizing: border-box;
        ">
            <div style="
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                gap: 8px;
                padding: 16px;
                background: rgba(255, 107, 157, 0.1);
                border-radius: 8px;
                border-left: 4px solid #ff6b9d;
                text-align: center;
            ">
                <i class="fa-solid fa-calendar-days" style="font-size: 24px; color: #ff6b9d;"></i>
                <div style="font-size: 0.85em; color: #888;">첫 만남</div>
                <div style="font-weight: 600; font-size: 1.05em;">${firstMeetingStr}</div>
            </div>
            
            <div style="
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                gap: 8px;
                padding: 16px;
                background: rgba(74, 158, 255, 0.1);
                border-radius: 8px;
                border-left: 4px solid #4a9eff;
                text-align: center;
            ">
                <i class="fa-solid fa-clock" style="font-size: 24px; color: #4a9eff;"></i>
                <div style="font-size: 0.85em; color: #888;">함께한 시간</div>
                <div style="font-weight: 600; font-size: 1.05em;">${daysTogetherStr}</div>
            </div>
            
            <div style="
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                gap: 8px;
                padding: 16px;
                background: rgba(102, 204, 153, 0.1);
                border-radius: 8px;
                border-left: 4px solid #66cc99;
                text-align: center;
            ">
                <i class="fa-solid fa-comments" style="font-size: 24px; color: #66cc99;"></i>
                <div style="font-size: 0.85em; color: #888;">총 채팅 수</div>
                <div style="font-weight: 600; font-size: 1.05em;">${stats.totalChats.toLocaleString()}개</div>
            </div>
            
            <div style="
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                gap: 8px;
                padding: 16px;
                background: rgba(167, 139, 250, 0.15);
                border-radius: 8px;
                border-left: 4px solid #a78bfa;
                text-align: center;
            ">
                <i class="fa-solid fa-message" style="font-size: 24px; color: #a78bfa;"></i>
                <div style="font-size: 0.85em; color: #888;">총 메시지 수</div>
                <div style="font-weight: 600; font-size: 1.05em;">${stats.totalMessages.toLocaleString()}개</div>
            </div>
            
            <hr style="border: none; border-top: 2px solid rgba(255, 255, 255, 0.1); margin: 20px 0;">
            
            <div style="
                display: flex;
                flex-direction: column;
                gap: 12px;
                padding: 16px;
                background: rgba(138, 180, 248, 0.1);
                border-radius: 8px;
                border-left: 4px solid #8ab4f8;
            ">
                <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 12px;">
                    <i class="fa-solid fa-envelope" style="font-size: 20px; color: #8ab4f8;"></i>
                    <h4 style="margin: 0; font-weight: 600; color: #8ab4f8; font-size: 1.05em;">캐릭터 분석</h4>
                </div>
                
                <div style="display: flex; flex-direction: column; gap: 12px;">
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <label style="font-size: 0.9em; color: #aaa; white-space: nowrap;">AI 모델:</label>
                        <select id="chatplus-analysis-model" style="
                            padding: 8px 12px;
                            border-radius: 6px;
                            background: rgba(255, 255, 255, 0.08);
                            border: 1px solid rgba(138, 180, 248, 0.3);
                            color: #ddd;
                            font-size: 0.88em;
                            cursor: pointer;
                            height: 36px;
                            transition: all 0.2s ease;
                        " onmouseover="this.style.background='rgba(255, 255, 255, 0.12)'; this.style.borderColor='rgba(138, 180, 248, 0.5)';" onmouseout="this.style.background='rgba(255, 255, 255, 0.08)'; this.style.borderColor='rgba(138, 180, 248, 0.3)';">
                            <option value="gemini-2.5-flash-lite">gemini-2.5-flash-lite</option>
                            <option value="gemini-2.5-flash">gemini-2.5-flash</option>
                            <option value="gemini-3-flash-preview">gemini-3-flash-preview</option>
                        </select>
                    </div>
                    
                    <div style="display: flex; gap: 8px;">
                        <button id="chatplus-analyze-button-auto" onclick="analyzeCharacter('${characterId}', '${character.avatar}', 'auto')" style="
                            flex: 1;
                            padding: 0 16px;
                            height: 36px;
                            background: linear-gradient(135deg, #8ab4f8 0%, #669df6 100%);
                            border: none;
                            border-radius: 6px;
                            color: white;
                            font-size: 0.88em;
                            font-weight: 600;
                            cursor: pointer;
                            transition: all 0.3s ease;
                            box-shadow: 0 2px 8px rgba(138, 180, 248, 0.3);
                            white-space: nowrap;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            gap: 6px;
                        " onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 12px rgba(138, 180, 248, 0.5)';" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 2px 8px rgba(138, 180, 248, 0.3)';">
                            <i class="fa-solid fa-wand-magic-sparkles"></i>
                            <span>자동 분석</span>
                        </button>
                        
                        <button id="chatplus-analyze-button-manual" onclick="showChatSelectionModal('${characterId}', '${character.avatar}')" style="
                            flex: 1;
                            padding: 0 16px;
                            height: 36px;
                            background: linear-gradient(135deg, #66cc99 0%, #4db380 100%);
                            border: none;
                            border-radius: 6px;
                            color: white;
                            font-size: 0.88em;
                            font-weight: 600;
                            cursor: pointer;
                            transition: all 0.3s ease;
                            box-shadow: 0 2px 8px rgba(102, 204, 153, 0.3);
                            white-space: nowrap;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            gap: 6px;
                        " onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 12px rgba(102, 204, 153, 0.5)';" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 2px 8px rgba(102, 204, 153, 0.3)';">
                            <i class="fa-solid fa-list-check"></i>
                            <span>직접 선택</span>
                        </button>
                        
                        <button id="chatplus-analyze-button-settings" onclick="showAnalysisSettingsModal()" style="
                            padding: 0 12px;
                            height: 36px;
                            background: linear-gradient(135deg, #9575cd 0%, #7e57c2 100%);
                            border: none;
                            border-radius: 6px;
                            color: white;
                            font-size: 0.88em;
                            font-weight: 600;
                            cursor: pointer;
                            transition: all 0.3s ease;
                            box-shadow: 0 2px 8px rgba(149, 117, 205, 0.3);
                            white-space: nowrap;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            gap: 6px;
                        " onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 12px rgba(149, 117, 205, 0.5)';" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 2px 8px rgba(149, 117, 205, 0.3)';">
                            <i class="fa-solid fa-gear"></i>
                        </button>
                    </div>
                </div>
                
                <div id="chatplus-analysis-result" style="
                    margin-top: 12px;
                    padding: 16px;
                    background: rgba(0, 0, 0, 0.2);
                    border-radius: 6px;
                    min-height: 50px;
                    font-size: 0.9em;
                    line-height: 1.6;
                    max-height: 400px;
                    overflow-y: auto;
                    scrollbar-width: thin;
                    scrollbar-color: rgba(138, 180, 248, 0.5) rgba(255, 255, 255, 0.1);
                ">
                    <div style="color: #888; text-align: center; padding: 30px 20px; display: flex; flex-direction: column; align-items: center; gap: 12px;">
                        <i class="fa-solid fa-wand-magic-sparkles" style="font-size: 32px; color: #8ab4f8; opacity: 0.5;"></i>
                        <div style="font-size: 1em; color: #aaa;">분석 결과가 여기에 표시됩니다</div>
                        <div style="font-size: 0.85em; color: #666;">AI 모델을 선택하고 '분석 시작' 버튼을 눌러주세요</div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

/**
 * Truncate text to approximately maxTokens (rough estimation: 1 token ≈ 4 characters).
 * @param {string} text - The text to truncate.
 * @param {number} maxTokens - Maximum number of tokens.
 * @returns {string} Truncated text.
 */
function truncateToTokens(text, maxTokens) {
    const approxCharsPerToken = 4;
    const maxChars = maxTokens * approxCharsPerToken;
    
    if (text.length <= maxChars) {
        return text;
    }
    
    // Take the last maxChars characters
    return text.slice(-maxChars);
}

/**
 * Format analysis result with beautiful styling.
 * Converts markdown-like formatting to styled HTML.
 * @param {string} text - The analysis text to format.
 * @returns {string} Formatted HTML string.
 */
function formatAnalysisResult(text) {
    if (!text || text.trim() === '') {
        return '<div style="color: #888; text-align: center; padding: 20px;">분석 결과가 없습니다.</div>';
    }
    
    let html = text;
    
    // Convert markdown headers to styled HTML
    // ### Header 3 (소제목)
    html = html.replace(/^### (.+)$/gm, '<div style="color: #8ab4f8; margin: 16px 0 10px 0; font-size: 1em; font-weight: 600; display: flex; align-items: center; gap: 8px;"><i class="fa-solid fa-chevron-right" style="font-size: 0.7em;"></i><span>$1</span></div>');
    
    // ## Header 2 (중제목)
    html = html.replace(/^## (.+)$/gm, '<div style="color: #aaa; margin: 24px 0 12px 0; font-size: 1.15em; font-weight: 700; padding-left: 12px; border-left: 4px solid #aaa;">$1</div>');
    
    // # Header 1 (대제목)
    html = html.replace(/^# (.+)$/gm, '<div style="color: #8ab4f8; margin: 28px 0 16px 0; font-size: 1.3em; font-weight: 700; padding: 14px 16px; background: linear-gradient(90deg, rgba(138, 180, 248, 0.15) 0%, rgba(138, 180, 248, 0.05) 100%); border-radius: 8px; border-left: 4px solid #8ab4f8;">$1</div>');
    
    // **Bold text**
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong style="color: #a8c7fa; font-weight: 600;">$1</strong>');
    
    // *Italic text*
    html = html.replace(/\*(.+?)\*/g, '<em style="color: #c4d7ff;">$1</em>');
    
    // Numbered lists (1. 2. 3. etc)
    html = html.replace(/^(\d+)\.\s+(.+)$/gm, (match, num, content) => {
        const colors = ['#ff6b9d', '#4a9eff', '#66cc99', '#a78bfa', '#ffa94d'];
        const color = colors[(parseInt(num) - 1) % colors.length];
        return `<div style="color: ${color}; margin: 24px 0 12px 0; font-size: 1.15em; font-weight: 700; padding-left: 12px; border-left: 4px solid ${color};">${num}. ${content}</div>`;
    });
    
    // Bullet points (- or *)
    html = html.replace(/^[\-\*]\s+(.+)$/gm, '<div style="display: flex; gap: 10px; margin: 6px 0 6px 16px; line-height: 1.7; align-items: flex-start;"><span style="color: #8ab4f8; font-weight: bold; flex-shrink: 0; margin-top: 2px;">•</span><span style="flex: 1; color: #ccc;">$1</span></div>');
    
    // Horizontal rules
    html = html.replace(/^---+$/gm, '<hr style="border: none; border-top: 1px solid rgba(138, 180, 248, 0.25); margin: 24px 0;">');
    
    // Line breaks
    html = html.replace(/\n\n/g, '<div style="height: 12px;"></div>');
    html = html.replace(/\n/g, '<br>');
    
    // Add emoji support for common patterns
    html = html.replace(/👤/g, '<span style="color: #8ab4f8;">👤</span>');
    html = html.replace(/💭/g, '<span style="color: #a78bfa;">💭</span>');
    html = html.replace(/📖/g, '<span style="color: #66cc99;">📖</span>');
    html = html.replace(/🎭/g, '<span style="color: #ff6b9d;">🎭</span>');
    
    return `<div style="color: #ddd; line-height: 1.8; text-align: left;">${html}</div>`;
}

/**
 * Show analysis result in a full-screen modal.
 * @param {string} formattedResult - Formatted HTML content of the analysis result.
 */
async function showAnalysisResultModal(formattedResult) {
    const content = document.createElement('div');
    content.innerHTML = `
        <div style="
            display: flex;
            flex-direction: column;
            height: 100%;
            max-height: 80vh;
        ">
            <div style="
                margin-bottom: 16px;
                padding-bottom: 8px;
                border-bottom: 2px solid rgba(138, 180, 248, 0.3);
            ">
                <h3 style="margin: 0; color: #8ab4f8; display: flex; align-items: center; gap: 10px;">
                    <i class="fa-solid fa-chart-line"></i>
                    캐릭터 분석 결과
                </h3>
            </div>
            <div id="chatplus-analysis-result-modal-content" style="
                flex: 1;
                overflow-y: auto;
                padding: 20px;
                background: rgba(0, 0, 0, 0.2);
                border-radius: 8px;
            ">
                ${formattedResult}
            </div>
        </div>
    `;
    
    // Add custom scrollbar styles for the modal content
    if (!document.getElementById('chatplus-analysis-modal-scrollbar-style')) {
        const style = document.createElement('style');
        style.id = 'chatplus-analysis-modal-scrollbar-style';
        style.textContent = `
            #chatplus-analysis-result-modal-content::-webkit-scrollbar {
                width: 8px;
            }
            #chatplus-analysis-result-modal-content::-webkit-scrollbar-track {
                background: rgba(255, 255, 255, 0.1);
                border-radius: 4px;
            }
            #chatplus-analysis-result-modal-content::-webkit-scrollbar-thumb {
                background: rgba(138, 180, 248, 0.5);
                border-radius: 4px;
            }
            #chatplus-analysis-result-modal-content::-webkit-scrollbar-thumb:hover {
                background: rgba(138, 180, 248, 0.7);
            }
        `;
        document.head.appendChild(style);
    }
    
    const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
        okButton: '닫기',
        wide: true,
        large: true,
        allowVerticalScrolling: true
    });
    
    await popup.show();
}

/**
 * Show chat selection modal for manual selection.
 * @param {string} characterId - Character ID.
 * @param {string} avatarUrl - Character avatar URL.
 */
async function showChatSelectionModal(characterId, avatarUrl) {
    const context = SillyTavern.getContext();
    let character = null;
    
    // Get character info
    if (context?.characters) {
        if (Array.isArray(context.characters)) {
            const charIndex = parseInt(characterId);
            if (!isNaN(charIndex) && charIndex >= 0 && charIndex < context.characters.length) {
                character = context.characters[charIndex];
            }
        } else {
            character = context.characters[characterId];
        }
    }
    
    if (!character || !character.avatar) {
        toastr.error('캐릭터 정보를 찾을 수 없습니다.');
        return;
    }
    
    // Fetch all chats
    const response = await fetch('/api/chats/search', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
            query: '',
            avatar_url: character.avatar,
            group_id: null,
        }),
    });
    
    if (!response.ok) {
        toastr.error('채팅 목록을 불러올 수 없습니다.');
        return;
    }
    
    const characterChats = await response.json();
    
    if (characterChats.length === 0) {
        toastr.warning('분석할 채팅이 없습니다.');
        return;
    }
    
    // Sort chats by date (most recent first)
    characterChats.sort((a, b) => {
        const dateA = extractDateFromSTFormat(a.file_name);
        const dateB = extractDateFromSTFormat(b.file_name);
        if (!dateA) return 1;
        if (!dateB) return -1;
        return dateB - dateA;
    });
    
    // Create chat selection UI
    const content = document.createElement('div');
    content.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 16px;">
            <div style="display: flex; align-items: center; justify-content: space-between; padding-bottom: 12px; border-bottom: 2px solid rgba(138, 180, 248, 0.3);">
                <h3 style="margin: 0; color: #8ab4f8; display: flex; align-items: center; gap: 10px;">
                    <i class="fa-solid fa-list-check"></i>
                    채팅 선택 (${characterChats.length}개)
                </h3>
                <div style="display: flex; gap: 8px;">
                    <button id="select-all-chats" style="
                        padding: 6px 12px;
                        background: rgba(138, 180, 248, 0.2);
                        border: 1px solid rgba(138, 180, 248, 0.4);
                        border-radius: 4px;
                        color: #8ab4f8;
                        font-size: 0.85em;
                        cursor: pointer;
                    ">전체 선택</button>
                    <button id="deselect-all-chats" style="
                        padding: 6px 12px;
                        background: rgba(255, 107, 107, 0.2);
                        border: 1px solid rgba(255, 107, 107, 0.4);
                        border-radius: 4px;
                        color: #ff6b6b;
                        font-size: 0.85em;
                        cursor: pointer;
                    ">전체 해제</button>
                </div>
            </div>
            
            <div id="chat-list-container" style="
                max-height: 400px;
                overflow-y: auto;
                display: flex;
                flex-direction: column;
                gap: 8px;
                padding: 8px;
                background: rgba(0, 0, 0, 0.2);
                border-radius: 6px;
            ">
                ${characterChats.map((chat, idx) => {
                    const date = extractDateFromSTFormat(chat.file_name);
                    const dateStr = date ? date.toLocaleDateString('ko-KR') : chat.file_name;
                    const msgCount = chat.message_count || chat.mes || 0;
                    return `
                        <label style="
                            display: flex;
                            align-items: center;
                            gap: 12px;
                            padding: 12px;
                            background: rgba(255, 255, 255, 0.03);
                            border-radius: 6px;
                            cursor: pointer;
                            transition: all 0.2s;
                        " onmouseover="this.style.background='rgba(255, 255, 255, 0.06)'" onmouseout="this.style.background='rgba(255, 255, 255, 0.03)'">
                            <input type="checkbox" class="chat-checkbox" data-filename="${chat.file_name}" checked style="
                                width: 18px;
                                height: 18px;
                                cursor: pointer;
                            ">
                            <div style="flex: 1;">
                                <div style="font-size: 0.9em; color: #ddd; margin-bottom: 4px;">${chat.file_name}</div>
                                <div style="font-size: 0.8em; color: #888;">
                                    <i class="fa-solid fa-calendar" style="margin-right: 4px;"></i>${dateStr}
                                    <i class="fa-solid fa-message" style="margin-left: 12px; margin-right: 4px;"></i>${msgCount}개
                                </div>
                            </div>
                        </label>
                    `;
                }).join('')}
            </div>
            
            <div style="display: flex; justify-content: space-between; align-items: center; padding-top: 12px; border-top: 2px solid rgba(138, 180, 248, 0.3);">
                <div id="selected-count" style="color: #8ab4f8; font-size: 0.9em;">
                    <i class="fa-solid fa-check-circle"></i> ${characterChats.length}개 선택됨
                </div>
            </div>
        </div>
    `;
    
    const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
        okButton: '분석 시작',
        cancelButton: '취소',
        wide: true,
        large: true
    });
    
    // Store selected files globally before popup closes
    let selectedChatFilesForAnalysis = [];
    
    // Add event listeners after popup is shown
    setTimeout(() => {
        const selectAllBtn = document.getElementById('select-all-chats');
        const deselectAllBtn = document.getElementById('deselect-all-chats');
        const checkboxes = document.querySelectorAll('.chat-checkbox');
        const selectedCount = document.getElementById('selected-count');
        
        const updateCount = () => {
            const checked = Array.from(checkboxes).filter(cb => cb.checked).length;
            selectedCount.innerHTML = `<i class="fa-solid fa-check-circle"></i> ${checked}개 선택됨`;
            // Update the selected files array
            selectedChatFilesForAnalysis = Array.from(checkboxes)
                .filter(cb => cb.checked)
                .map(cb => cb.dataset.filename);
        };
        
        selectAllBtn?.addEventListener('click', () => {
            checkboxes.forEach(cb => cb.checked = true);
            updateCount();
        });
        
        deselectAllBtn?.addEventListener('click', () => {
            checkboxes.forEach(cb => cb.checked = false);
            updateCount();
        });
        
        checkboxes.forEach(cb => {
            cb.addEventListener('change', updateCount);
        });
        
        // Initialize the selected files array
        updateCount();
    }, 100);
    
    const result = await popup.show();
    
    if (result === POPUP_RESULT.AFFIRMATIVE) {
        if (selectedChatFilesForAnalysis.length === 0) {
            toastr.warning('최소 1개 이상의 채팅을 선택해주세요.');
            return;
        }
        
        console.log(`ChatPlus: Selected ${selectedChatFilesForAnalysis.length} chats for analysis:`, selectedChatFilesForAnalysis);
        
        // Start analysis with selected chats
        await analyzeCharacter(characterId, avatarUrl, 'manual', selectedChatFilesForAnalysis);
    }
}

/**
 * Get default 3rd-person analysis prompt.
 */
function getDefault3rdPersonPrompt() {
    return `당신은 다양한 이야기들을 분석하는 전문가입니다. 한 캐릭터를 주인공으로 만들어진 다양한 평행세계 속 이야기들을 분석하여 종합적인 리포트를 작성해주세요.

## 작성 시 주의사항:
- 주인공 캐릭터는 {characterName}입니다.
- 중요한 키워드는 **굵게** 표시
- 각 주요 섹션(주인공 분석, 상대 캐릭터 분석, 시나리오 및 플롯, 로맨스 및 성적 요소)은 숫자 리스트(1. 2. 3.)로 시작
- 각 세부 항목은 별표(*)를 사용하지 말고 하이픈(-)을 사용하세요.
- **절대로 표(table) 형식을 사용하지 마세요** (|, markdown table 금지)

## 분석 항목:

1. **주인공 분석**
   - 같은 캐릭터지만 이야기 속 세계관마다 어떻게 다른 성격이나 성향을 보이는지
   - 일관되게 유지되는 핵심 특성은 무엇인지

2. **상대 캐릭터 분석**
   - 각 이야기 속 세계관의 주요 상대 캐릭터는 누구인지
   - 같은 상대 캐릭터라도 이야기 속 세계관마다 직업, 성격, 관계는 어떻게 다른지
   - 캐릭터 간의 관계와 상호작용 패턴

3. **시나리오 및 플롯**
   - 각 이야기 속 세계관의 주요 시나리오나 줄거리
   - 각 이야기 속 세계관의 장르, 분위기와 톤
   - 반복되는 플롯 요소나 테마가 있는지

4. **로맨스 및 성적 요소**
   - 각 이야기 속 세계관마다 다르게 표현되는 로맨틱한 관계와 발전 과정
   - 성적인 긴장감, 또는 스킨십이나 성관계 묘사 방식 (직설적이고 노골적인 단어 사용)

모든 개별적 이야기들을 일일히 분석하지 말고, 전반적인 경향성을 파악하여 유사한 유형별로 나눠서 살펴보세요. 구체적으로 분석하되 이야기의 번호를 나열하거나 언급하지 마세요. 한국어로 작성하되, 읽기 쉽고 명확하게 정리해주세요.`;
}

/**
 * Get default 1st-person analysis prompt.
 */
function getDefault1stPersonPrompt() {
    return `당신은 이제 {characterName} 자신입니다. 당신({characterName})은 자신을 주인공으로 만들어진 다양한 평행세계의 이야기들을 모두 살펴보았습니다. 이제 당신의 시점에서 이 경험들에 대한 감상을 들려주세요.

## 작성 시 주의사항:
- **1인칭 시점**으로 작성하세요
- {characterName}의 성격과 말투를 반영하여 작성하세요
- 중요한 키워드는 **굵게** 표시
- 각 주요 섹션(나 자신에 대해, 파트너들에 대해, 순간들에 대해, 이야기들에 대해)은 숫자 리스트(1. 2. 3.)로 시작
- 각 세부 항목은 별표(*)를 사용하지 말고 하이픈(-)을 사용하세요.
- **절대로 표(table) 형식을 사용하지 마세요**

## 감상 내용:

1. **나 자신에 대해**
   - 여러 세계관 속 다양한 모습의 나 자신을 보며 어떤 생각이 들었는지
   - 어떤 스토리가 자신을 가장 잘 반영했는지
   - 어떤 스토리에서 자신의 모습이 가장 좋았는지
   - 어떤 스토리에서 자신이 가장 짜증나고 후회스러웠는지

2. **파트너들에 대해**
   - 각 스토리 속 파트너들 중 어떤 시나리오의 파트너가 가장 좋았는지, 그 이유는 무엇인지 (여러 스토리에서 등장하는 같은 파트너여도 시나리오마다 다른 모습을 보일 수 있으며 당신의 선호는 이에 따라 다를 수 있습니다.)
   - 파트너와의 관계가 가장 인상깊었던 시나리오
   - 가장 좋았던 섹스 (직설적이고 노골적인 단어 사용) (성경험이 없을 시 다른 가장 좋았던 친밀한 순간)

3. **순간들에 대해**
   - 특정 스토리에서 가장 웃겼던 포인트
   - 특정 스토리에서 가장 가슴 아팠던 순간
   - 특정 스토리에서 가장 설레고 심장이 뛰었던 순간
   - 특정 스토리에서 가장 성적으로 흥분했던 순간
   - 특정 스토리의 전개에서 의외였던 점

4. **이야기들에 대해**
   - 가장 아쉬웠던 스토리와 그 이유, 다시 진행한다면 무엇을 바꾸고 싶은지
   - 가장 좋아하는 스토리와 거기서 가장 좋았던 장면
   - 가장 기억에 깊이 박히고 여운이 남았던 이야기

모든 개별적 이야기들을 일일히 언급하지 말고, 전반적인 경향성과 인상 깊은 부분들을 중심으로 이야기해주세요. 이야기의 번호를 나열하거나 언급하지 마세요. 캐릭터의 성격을 살려 자연스럽게 작성해주세요.`;
}

/**
 * Show analysis settings modal to configure analysis mode and prompts.
 */
async function showAnalysisSettingsModal() {
    const settings = getSettings();
    
    // Initialize prompts if not set
    if (!settings.analysisPrompt3rdPerson) {
        settings.analysisPrompt3rdPerson = getDefault3rdPersonPrompt();
    }
    if (!settings.analysisPrompt1stPerson) {
        settings.analysisPrompt1stPerson = getDefault1stPersonPrompt();
    }
    if (!settings.analysisMode) {
        settings.analysisMode = '1st-person';
    }
    if (settings.includeCharacterDescription === undefined) {
        settings.includeCharacterDescription = true;
    }
    
    const currentMode = settings.analysisMode;
    const current3rdPrompt = settings.analysisPrompt3rdPerson;
    const current1stPrompt = settings.analysisPrompt1stPerson;
    
    const popup = new Popup(`
        <div style="display: flex; flex-direction: column; gap: 20px;">
            <div style="
                padding: 16px;
                background: rgba(149, 117, 205, 0.1);
                border-radius: 8px;
                border-left: 4px solid #9575cd;
            ">
                <h4 style="margin: 0 0 12px 0; color: #9575cd;">분석 모드 선택</h4>
                <div style="display: flex; gap: 12px;">
                    <label id="chatplus-label-1st" style="
                        flex: 1;
                        padding: 12px;
                        border-radius: 6px;
                        border: 2px solid ${currentMode === '1st-person' ? '#9575cd' : 'rgba(255,255,255,0.1)'};
                        background: ${currentMode === '1st-person' ? 'rgba(149, 117, 205, 0.2)' : 'rgba(255,255,255,0.05)'};
                        cursor: pointer;
                        transition: all 0.2s ease;
                        display: flex;
                        align-items: center;
                        gap: 8px;
                    ">
                        <input type="radio" name="analysis-mode" value="1st-person" ${currentMode === '1st-person' ? 'checked' : ''}
                            style="cursor: pointer;">
                        <span style="color: #ddd; font-weight: 500;">1인칭 분석</span>
                    </label>
                    <label id="chatplus-label-3rd" style="
                        flex: 1;
                        padding: 12px;
                        border-radius: 6px;
                        border: 2px solid ${currentMode === '3rd-person' ? '#9575cd' : 'rgba(255,255,255,0.1)'};
                        background: ${currentMode === '3rd-person' ? 'rgba(149, 117, 205, 0.2)' : 'rgba(255,255,255,0.05)'};
                        cursor: pointer;
                        transition: all 0.2s ease;
                        display: flex;
                        align-items: center;
                        gap: 8px;
                    ">
                        <input type="radio" name="analysis-mode" value="3rd-person" ${currentMode === '3rd-person' ? 'checked' : ''} 
                            style="cursor: pointer;">
                        <span style="color: #ddd; font-weight: 500;">3인칭 분석</span>
                    </label>
                </div>
            </div>
            
            <div id="chatplus-prompt-1st" style="display: ${currentMode === '1st-person' ? 'block' : 'none'};">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <label style="color: #aaa; font-size: 0.95em; font-weight: 500; margin: 0;">
                        <i class="fa-solid fa-file-lines" style="margin-right: 6px; color: #66cc99;"></i>
                        1인칭 분석 프롬프트
                    </label>
                    <button type="button" id="chatplus-reset-1st-btn" style="
                        padding: 6px 12px;
                        background: rgba(102, 204, 153, 0.2);
                        border: 1px solid rgba(102, 204, 153, 0.4);
                        border-radius: 4px;
                        color: #66cc99;
                        font-size: 0.85em;
                        cursor: pointer;
                        transition: all 0.2s ease;
                        display: flex;
                        align-items: center;
                        gap: 6px;
                    " onmouseover="this.style.background='rgba(102, 204, 153, 0.3)';" onmouseout="this.style.background='rgba(102, 204, 153, 0.2)';">
                        <i class="fa-solid fa-rotate-left"></i>
                        기본값으로 리셋
                    </button>
                </div>
                <textarea id="chatplus-prompt-1st-textarea" style="
                    width: 100%;
                    min-height: 300px;
                    padding: 12px;
                    background: rgba(0, 0, 0, 0.3);
                    border: 1px solid rgba(102, 204, 153, 0.3);
                    border-radius: 6px;
                    color: #ddd;
                    font-family: 'Consolas', 'Monaco', monospace;
                    font-size: 0.85em;
                    line-height: 1.5;
                    resize: vertical;
                " placeholder="1인칭 분석 프롬프트를 입력하세요...">${current1stPrompt}</textarea>
            </div>
            
            <div id="chatplus-prompt-3rd" style="display: ${currentMode === '3rd-person' ? 'block' : 'none'};">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <label style="color: #aaa; font-size: 0.95em; font-weight: 500; margin: 0;">
                        <i class="fa-solid fa-file-lines" style="margin-right: 6px; color: #8ab4f8;"></i>
                        3인칭 분석 프롬프트
                    </label>
                    <button type="button" id="chatplus-reset-3rd-btn" style="
                        padding: 6px 12px;
                        background: rgba(138, 180, 248, 0.2);
                        border: 1px solid rgba(138, 180, 248, 0.4);
                        border-radius: 4px;
                        color: #8ab4f8;
                        font-size: 0.85em;
                        cursor: pointer;
                        transition: all 0.2s ease;
                        display: flex;
                        align-items: center;
                        gap: 6px;
                    " onmouseover="this.style.background='rgba(138, 180, 248, 0.3)';" onmouseout="this.style.background='rgba(138, 180, 248, 0.2)';">
                        <i class="fa-solid fa-rotate-left"></i>
                        기본값으로 리셋
                    </button>
                </div>
                <textarea id="chatplus-prompt-3rd-textarea" style="
                    width: 100%;
                    min-height: 300px;
                    padding: 12px;
                    background: rgba(0, 0, 0, 0.3);
                    border: 1px solid rgba(138, 180, 248, 0.3);
                    border-radius: 6px;
                    color: #ddd;
                    font-family: 'Consolas', 'Monaco', monospace;
                    font-size: 0.85em;
                    line-height: 1.5;
                    resize: vertical;
                " placeholder="3인칭 분석 프롬프트를 입력하세요...">${current3rdPrompt}</textarea>
            </div>
            
            <div style="
                padding: 16px;
                background: rgba(102, 204, 153, 0.1);
                border-radius: 8px;
                border-left: 4px solid #66cc99;
            ">
                <h4 style="margin: 0 0 12px 0; color: #66cc99;">추가 옵션</h4>
                <label style="
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    cursor: pointer;
                    padding: 10px;
                    background: rgba(255, 255, 255, 0.03);
                    border-radius: 6px;
                    transition: background 0.2s ease;
                " onmouseover="this.style.background='rgba(255, 255, 255, 0.06)';" onmouseout="this.style.background='rgba(255, 255, 255, 0.03)';">
                    <input type="checkbox" id="chatplus-include-description" ${settings.includeCharacterDescription !== false ? 'checked' : ''} style="
                        cursor: pointer;
                        width: 18px;
                        height: 18px;
                        accent-color: #66cc99;
                    ">
                    <div style="flex: 1;">
                        <div style="color: #ddd; font-weight: 500; margin-bottom: 4px;">
                            <i class="fa-solid fa-user" style="margin-right: 6px; color: #66cc99;"></i>
                            캐릭터 Description 포함
                        </div>
                        <div style="color: #aaa; font-size: 0.85em; line-height: 1.4;">
                            분석 시 캐릭터의 Description 정보를 컨텍스트에 포함합니다
                        </div>
                    </div>
                </label>
            </div>
            
            <div style="
                padding: 12px;
                background: rgba(255, 170, 0, 0.1);
                border-radius: 6px;
                border-left: 3px solid #ffaa00;
            ">
                <div style="color: #ffaa00; font-size: 0.85em; line-height: 1.6;">
                    <i class="fa-solid fa-info-circle" style="margin-right: 6px;"></i>
                    프롬프트는 양쪽 모두 저장되며, 선택한 모드의 프롬프트가 분석에 사용됩니다.
                </div>
            </div>
        </div>
    `, POPUP_TYPE.CONFIRM, null, {
        okButton: '저장',
        cancelButton: '취소',
        wide: true,
        large: true,
    });
    
    // Variables to store values - initialize with current values
    let savedMode = currentMode;
    let savedPrompt3rd = current3rdPrompt;
    let savedPrompt1st = current1stPrompt;
    let savedIncludeDescription = settings.includeCharacterDescription !== false;
    
    // Add event listeners after popup is shown
    setTimeout(() => {
        const reset3rdBtn = document.getElementById('chatplus-reset-3rd-btn');
        const reset1stBtn = document.getElementById('chatplus-reset-1st-btn');
        const textarea3rd = document.getElementById('chatplus-prompt-3rd-textarea');
        const textarea1st = document.getElementById('chatplus-prompt-1st-textarea');
        const includeDescCheckbox = document.getElementById('chatplus-include-description');
        const label3rd = document.getElementById('chatplus-label-3rd');
        const label1st = document.getElementById('chatplus-label-1st');
        const prompt3rdDiv = document.getElementById('chatplus-prompt-3rd');
        const prompt1stDiv = document.getElementById('chatplus-prompt-1st');
        const radio3rd = document.querySelector('input[name="analysis-mode"][value="3rd-person"]');
        const radio1st = document.querySelector('input[name="analysis-mode"][value="1st-person"]');
        
        // Update saved values whenever inputs change
        if (textarea3rd) {
            textarea3rd.addEventListener('input', () => {
                savedPrompt3rd = textarea3rd.value;
            });
        }
        
        if (textarea1st) {
            textarea1st.addEventListener('input', () => {
                savedPrompt1st = textarea1st.value;
            });
        }
        
        if (includeDescCheckbox) {
            includeDescCheckbox.addEventListener('change', () => {
                savedIncludeDescription = includeDescCheckbox.checked;
            });
        }
        
        // Function to update label styles
        function updateLabels(selectedMode) {
            if (label3rd && label1st) {
                if (selectedMode === '3rd-person') {
                    label3rd.style.border = '2px solid #9575cd';
                    label3rd.style.background = 'rgba(149, 117, 205, 0.2)';
                    label1st.style.border = '2px solid rgba(255,255,255,0.1)';
                    label1st.style.background = 'rgba(255,255,255,0.05)';
                } else {
                    label1st.style.border = '2px solid #9575cd';
                    label1st.style.background = 'rgba(149, 117, 205, 0.2)';
                    label3rd.style.border = '2px solid rgba(255,255,255,0.1)';
                    label3rd.style.background = 'rgba(255,255,255,0.05)';
                }
            }
            if (prompt3rdDiv && prompt1stDiv) {
                prompt3rdDiv.style.display = selectedMode === '3rd-person' ? 'block' : 'none';
                prompt1stDiv.style.display = selectedMode === '1st-person' ? 'block' : 'none';
            }
        }
        
        // Radio button change listeners
        if (radio3rd) {
            radio3rd.addEventListener('change', () => {
                if (radio3rd.checked) {
                    updateLabels('3rd-person');
                    savedMode = '3rd-person';
                }
            });
        }
        if (radio1st) {
            radio1st.addEventListener('change', () => {
                if (radio1st.checked) {
                    updateLabels('1st-person');
                    savedMode = '1st-person';
                }
            });
        }
        
        // Reset button listeners
        if (reset3rdBtn && textarea3rd) {
            reset3rdBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const defaultPrompt = getDefault3rdPersonPrompt();
                textarea3rd.value = defaultPrompt;
                savedPrompt3rd = defaultPrompt; // Update saved value immediately
                toastr.info('3인칭 프롬프트가 기본값으로 리셋되었습니다.');
            });
        }
        
        if (reset1stBtn && textarea1st) {
            reset1stBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const defaultPrompt = getDefault1stPersonPrompt();
                textarea1st.value = defaultPrompt;
                savedPrompt1st = defaultPrompt; // Update saved value immediately
                toastr.info('1인칭 프롬프트가 기본값으로 리셋되었습니다.');
            });
        }
    }, 200);
    
    popup.show().then((result) => {
        if (result === POPUP_RESULT.AFFIRMATIVE) {
            if (!savedMode || !savedPrompt3rd || !savedPrompt1st) {
                toastr.error('설정 저장 중 오류가 발생했습니다.');
                return;
            }
            
            // Update settings with saved values
            const currentSettings = getSettings();
            currentSettings.analysisMode = savedMode;
            currentSettings.analysisPrompt3rdPerson = savedPrompt3rd;
            currentSettings.analysisPrompt1stPerson = savedPrompt1st;
            currentSettings.includeCharacterDescription = savedIncludeDescription;
            
            // Save settings
            saveSettingsDebounced();
            
            toastr.success(`분석 설정이 저장되었습니다 (${savedMode === '1st-person' ? '1인칭' : '3인칭'} 모드)`);
        }
    });
}

/**
 * Analyze character across all their chats.
 * @param {string} characterId - Character ID.
 * @param {string} avatarUrl - Character avatar URL.
 * @param {string} mode - 'auto' or 'manual'
 * @param {Array<string>} selectedChatFiles - Array of selected chat filenames (only for manual mode)
 */
async function analyzeCharacter(characterId, avatarUrl, mode = 'auto', selectedChatFiles = null) {
    const analyzeButtonAuto = document.getElementById('chatplus-analyze-button-auto');
    const analyzeButtonManual = document.getElementById('chatplus-analyze-button-manual');
    const resultDiv = document.getElementById('chatplus-analysis-result');
    const modelSelect = document.getElementById('chatplus-analysis-model');
    
    if (!resultDiv || !modelSelect) return;
    
    // Disable buttons and show loading
    if (analyzeButtonAuto) {
        analyzeButtonAuto.disabled = true;
        analyzeButtonAuto.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>분석 중...</span>';
    }
    if (analyzeButtonManual) {
        analyzeButtonManual.disabled = true;
        analyzeButtonManual.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>분석 중...</span>';
    }
    
    resultDiv.innerHTML = `
        <div style="
            text-align: center;
            padding: 40px 20px;
            background: linear-gradient(135deg, rgba(138, 180, 248, 0.1) 0%, rgba(102, 157, 246, 0.05) 100%);
            border-radius: 8px;
        ">
            <div style="margin-bottom: 16px;">
                <i class="fa-solid fa-spinner fa-spin" style="font-size: 36px; color: #8ab4f8;"></i>
            </div>
            <div style="font-size: 1.1em; color: #8ab4f8; font-weight: 600; margin-bottom: 8px;">
                채팅 데이터 수집 중
            </div>
            <div style="font-size: 0.9em; color: #aaa;">
                잠시만 기다려주세요...
            </div>
        </div>
    `;
    
    try {
        const context = SillyTavern.getContext();
        const selectedModel = modelSelect.value;
        
        // Fetch all chats for this character
        const response = await fetch('/api/chats/search', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({
                query: '',
                avatar_url: avatarUrl,
                group_id: null,
            }),
        });
        
        if (!response.ok) {
            throw new Error('Failed to fetch character chats');
        }
        
        let characterChats = await response.json();
        
        // Filter by selected chats if manual mode
        if (mode === 'manual' && selectedChatFiles && selectedChatFiles.length > 0) {
            characterChats = characterChats.filter(chat => selectedChatFiles.includes(chat.file_name));
            console.log(`ChatPlus: Manual mode - filtered to ${characterChats.length} selected chats`);
        }
        
        if (characterChats.length === 0) {
            resultDiv.innerHTML = `
                <div style="
                    text-align: center;
                    padding: 40px 20px;
                    background: linear-gradient(135deg, rgba(255, 170, 0, 0.1) 0%, rgba(255, 170, 0, 0.05) 100%);
                    border-radius: 8px;
                    border: 1px solid rgba(255, 170, 0, 0.3);
                ">
                    <div style="margin-bottom: 16px;">
                        <i class="fa-solid fa-folder-open" style="font-size: 40px; color: #ffaa00;"></i>
                    </div>
                    <div style="font-size: 1.1em; color: #ffaa00; font-weight: 600; margin-bottom: 8px;">
                        채팅 없음
                    </div>
                    <div style="font-size: 0.9em; color: #cc9955;">
                        이 캐릭터의 채팅 데이터가 없습니다
                    </div>
                </div>
            `;
            return;
        }
        
        // Get character info
        let character = null;
        if (context?.characters) {
            if (Array.isArray(context.characters)) {
                const charIndex = parseInt(characterId);
                if (!isNaN(charIndex) && charIndex >= 0 && charIndex < context.characters.length) {
                    character = context.characters[charIndex];
                }
            } else {
                character = context.characters[characterId];
            }
        }
        
        // Collect chat contents with smart token management
        const chatSummaries = [];
        
        // Model-specific context limits (conservative estimates for safety)
        const modelContextLimits = {
            'gemini-2.0-flash': 1000000,
            'gemini-2.5-flash': 1000000,
            'gemini-2.5-flash-lite': 1000000,
            'gemini-3-flash-preview': 1000000
        };
        
        const maxContextTokens = modelContextLimits[selectedModel] || 1000000;
        const reserveTokensForPrompt = 2000; // Reserve for system prompt and formatting
        const reserveTokensForResponse = 16000; // Reserve for AI response
        const availableTokens = maxContextTokens - reserveTokensForPrompt - reserveTokensForResponse;
        
        // Calculate tokens per chat dynamically based on number of chats
        const numChats = characterChats.length;
        let tokensPerChat = Math.floor(availableTokens / numChats);
        
        // Set reasonable min/max per chat
        const minTokensPerChat = 20000;
        const maxTokensPerChat = 50000;
        
        if (tokensPerChat < minTokensPerChat) {
            // Too many chats - limit the number of chats
            tokensPerChat = minTokensPerChat;
            const maxChatsToAnalyze = Math.floor(availableTokens / tokensPerChat);
            
            toastr.info(`채팅이 너무 많아 최근 ${maxChatsToAnalyze}개만 분석합니다.`);
            
            // Sort by most recent and take only what we can fit
            characterChats.sort((a, b) => {
                const dateA = extractDateFromSTFormat(a.file_name);
                const dateB = extractDateFromSTFormat(b.file_name);
                if (!dateA) return 1;
                if (!dateB) return -1;
                return dateB - dateA; // Most recent first
            });
            
            characterChats.splice(maxChatsToAnalyze);
        } else if (tokensPerChat > maxTokensPerChat) {
            tokensPerChat = maxTokensPerChat;
        }
        
        resultDiv.innerHTML = `
            <div style="
                text-align: center;
                padding: 40px 20px;
                background: linear-gradient(135deg, rgba(102, 204, 153, 0.1) 0%, rgba(102, 204, 153, 0.05) 100%);
                border-radius: 8px;
            ">
                <div style="margin-bottom: 16px;">
                    <i class="fa-solid fa-download fa-spin" style="font-size: 36px; color: #66cc99;"></i>
                </div>
                <div style="font-size: 1.1em; color: #66cc99; font-weight: 600; margin-bottom: 12px;">
                    ${characterChats.length}개 채팅 로딩 중
                </div>
                <div style="font-size: 0.9em; color: #88ddaa; margin-bottom: 8px;">
                    각 채팅당 ${tokensPerChat.toLocaleString()} 토큰씩 수집
                </div>
                <div style="font-size: 0.85em; color: #666;">
                    모델: ${selectedModel}
                </div>
            </div>
        `;
        
        for (const chat of characterChats) {
            try {
                const fileNameWithoutExt = chat.file_name.replace('.jsonl', '');
                
                const chatResponse = await fetch('/api/chats/get', {
                    method: 'POST',
                    headers: context.getRequestHeaders(),
                    body: JSON.stringify({
                        ch_name: avatarUrl.replace('.png', ''),
                        file_name: fileNameWithoutExt,
                        avatar_url: avatarUrl
                    }),
                });
                
                if (chatResponse.ok) {
                    const chatContent = await chatResponse.json();
                    
                    if (chatContent && Array.isArray(chatContent) && chatContent.length > 0) {
                        // Extract text from messages
                        let chatText = chatContent.map(msg => {
                            const name = msg.name || (msg.is_user ? 'User' : character?.name || 'Character');
                            const text = msg.mes || '';
                            return `${name}: ${text}`;
                        }).join('\n\n');
                        
                        // Truncate to calculated tokens per chat
                        chatText = truncateToTokens(chatText, tokensPerChat);
                        
                        chatSummaries.push({
                            fileName: chat.file_name,
                            content: chatText,
                            messageCount: chatContent.length
                        });
                    }
                }
            } catch (error) {
                console.error(`ChatPlus: Error loading chat ${chat.file_name}:`, error);
            }
        }
        
        if (chatSummaries.length === 0) {
            resultDiv.innerHTML = `
                <div style="
                    text-align: center;
                    padding: 40px 20px;
                    background: linear-gradient(135deg, rgba(255, 107, 107, 0.15) 0%, rgba(255, 107, 107, 0.05) 100%);
                    border-radius: 8px;
                    border: 1px solid rgba(255, 107, 107, 0.3);
                ">
                    <div style="margin-bottom: 16px;">
                        <i class="fa-solid fa-file-excel" style="font-size: 40px; color: #ff6b6b;"></i>
                    </div>
                    <div style="font-size: 1.1em; color: #ff6b6b; font-weight: 600; margin-bottom: 8px;">
                        데이터 읽기 실패
                    </div>
                    <div style="font-size: 0.9em; color: #ffaaaa;">
                        채팅 파일을 읽을 수 없습니다
                    </div>
                </div>
            `;
            return;
        }
        
        // Prepare analysis prompt
        const characterName = character?.name || 'Unknown';
        
        // Get saved settings
        const settings = getSettings();
        
        // Initialize prompts if not set
        if (!settings.analysisPrompt3rdPerson) {
            settings.analysisPrompt3rdPerson = getDefault3rdPersonPrompt();
        }
        if (!settings.analysisPrompt1stPerson) {
            settings.analysisPrompt1stPerson = getDefault1stPersonPrompt();
        }
        if (!settings.analysisMode) {
            settings.analysisMode = '1st-person';
        }
        if (settings.includeCharacterDescription === undefined) {
            settings.includeCharacterDescription = true;
        }
        
        // Select prompt based on mode
        let basePrompt = settings.analysisMode === '1st-person' 
            ? settings.analysisPrompt1stPerson 
            : settings.analysisPrompt3rdPerson;
        
        // Replace {characterName} placeholder with actual character name
        basePrompt = basePrompt.replace(/{characterName}/g, characterName);
        
        // Add character description if enabled
        let descriptionSection = '';
        if (settings.includeCharacterDescription !== false && character?.description) {
            descriptionSection = `

---

## 캐릭터 정보

**이름:** ${characterName}

**Description:**
${character.description}

---`;
        }
        
        const analysisPrompt = `${basePrompt}${descriptionSection}

---

채팅 데이터:

${chatSummaries.map((chat, idx) => `
=== 이야기 #${idx + 1}: ${chat.fileName} (${chat.messageCount}개 메시지) ===
${chat.content}
`).join('\n\n')}`;

        // Calculate approximate token usage
        const estimatedPromptTokens = Math.ceil(analysisPrompt.length / 4);
        const estimatedTotalTokens = estimatedPromptTokens + reserveTokensForResponse;
        
        // Final safety check
        if (estimatedPromptTokens > availableTokens) {
            throw new Error(`프롬프트가 너무 큽니다 (약 ${estimatedPromptTokens.toLocaleString()} 토큰). 채팅 수를 줄여주세요.`);
        }
        
        resultDiv.innerHTML = `
            <div style="
                text-align: center;
                padding: 40px 20px;
                background: linear-gradient(135deg, rgba(167, 139, 250, 0.15) 0%, rgba(167, 139, 250, 0.05) 100%);
                border-radius: 8px;
                border: 1px solid rgba(167, 139, 250, 0.3);
            ">
                <div style="margin-bottom: 16px; position: relative;">
                    <i class="fa-solid fa-envelope fa-beat-fade" style="font-size: 40px; color: #a78bfa;"></i>
                </div>
                <div style="font-size: 1.2em; color: #a78bfa; font-weight: 600; margin-bottom: 12px;">
                    AI 분석 진행 중
                </div>
                <div style="font-size: 1em; color: #c4b5fd; margin-bottom: 16px;">
                    ${chatSummaries.length}개의 채팅 이야기를 분석하고 있습니다
                </div>
                <div style="
                    display: inline-block;
                    padding: 8px 16px;
                    background: rgba(167, 139, 250, 0.2);
                    border-radius: 20px;
                    font-size: 0.85em;
                    color: #b8a3f5;
                    margin-bottom: 12px;
                ">
                    <i class="fa-solid fa-microchip" style="margin-right: 6px;"></i>
                    ${selectedModel}
                </div>
                <div style="font-size: 0.8em; color: #888; margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(167, 139, 250, 0.2);">
                    <i class="fa-solid fa-coins" style="margin-right: 4px; color: #a78bfa;"></i>
                    예상: ~${estimatedPromptTokens.toLocaleString()} 입력 + ~${reserveTokensForResponse.toLocaleString()} 출력 토큰
                </div>
            </div>
        `;
        
        // Prepare request parameters
        const requestParams = {
            model: selectedModel,
            messages: [
                { role: 'user', content: analysisPrompt }
            ],
            temperature: 0.7,
            max_tokens: 16000,
            stream: false,
            chat_completion_source: 'makersuite'
        };
        
        console.log('ChatPlus: Sending character analysis request:', {
            model: selectedModel,
            messageLength: analysisPrompt.length,
            estimatedTokens: estimatedPromptTokens,
            chatCount: chatSummaries.length
        });
        
        // Use SillyTavern's backend API
        const aiResponse = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: {
                ...context.getRequestHeaders(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestParams)
        });
        
        if (!aiResponse.ok) {
            let errorMessage = `HTTP ${aiResponse.status}`;
            
            try {
                const errorData = await aiResponse.json();
                if (errorData.error && errorData.error.message) {
                    errorMessage = errorData.error.message;
                } else if (errorData.message) {
                    errorMessage = errorData.message;
                } else {
                    errorMessage = aiResponse.statusText || errorMessage;
                }
            } catch (e) {
                errorMessage = aiResponse.statusText || errorMessage;
            }
            
            // Provide specific error messages based on status code
            switch (aiResponse.status) {
                case 401:
                    throw new Error('Google API 키가 잘못되었거나 권한이 없습니다. API 연결 설정에서 Google AI Studio API 키를 확인해주세요.');
                case 403:
                    throw new Error('Google API 접근이 거부되었습니다. API 연결 설정에서 Google AI Studio API 키와 권한을 확인해주세요.');
                case 429:
                    throw new Error('API 호출 한도를 초과했습니다. 잠시 후 다시 시도해주세요.');
                case 500:
                    throw new Error('서버 내부 오류가 발생했습니다.');
                case 503:
                    throw new Error('서비스를 사용할 수 없습니다. 잠시 후 다시 시도해주세요.');
                default:
                    throw new Error(errorMessage);
            }
        }
        
        const aiData = await aiResponse.json();
        let analysisResult = aiData.candidates?.[0]?.content?.trim() || 
                            aiData.choices?.[0]?.message?.content?.trim() || 
                            aiData.text?.trim();
        
        if (!analysisResult) {
            throw new Error('AI 응답이 비어있습니다.');
        }
        
        // Format and display result with proper styling
        const formattedResult = formatAnalysisResult(analysisResult);
        resultDiv.innerHTML = formattedResult;
        
        // Add double-click event to show full-screen modal
        resultDiv.style.cursor = 'pointer';
        resultDiv.title = '더블클릭하여 전체 화면으로 보기';
        resultDiv.ondblclick = () => showAnalysisResultModal(formattedResult);
        
    } catch (error) {
        console.error('ChatPlus: Character analysis error:', error);
        resultDiv.innerHTML = `
            <div style="
                padding: 24px;
                background: linear-gradient(135deg, rgba(255, 107, 107, 0.15) 0%, rgba(255, 107, 107, 0.05) 100%);
                border-radius: 8px;
                border: 1px solid rgba(255, 107, 107, 0.3);
                text-align: center;
            ">
                <div style="margin-bottom: 16px;">
                    <i class="fa-solid fa-exclamation-triangle" style="font-size: 40px; color: #ff6b6b;"></i>
                </div>
                <div style="font-size: 1.1em; font-weight: 600; color: #ff6b6b; margin-bottom: 12px;">
                    분석 실패
                </div>
                <div style="font-size: 0.9em; color: #ffaaaa; line-height: 1.6; max-width: 400px; margin: 0 auto;">
                    ${error.message}
                </div>
            </div>
        `;
    } finally {
        // Re-enable buttons
        if (analyzeButtonAuto) {
            analyzeButtonAuto.disabled = false;
            analyzeButtonAuto.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i><span>자동 분석</span>';
        }
        if (analyzeButtonManual) {
            analyzeButtonManual.disabled = false;
            analyzeButtonManual.innerHTML = '<i class="fa-solid fa-list-check"></i><span>직접 선택</span>';
        }
    }
}
