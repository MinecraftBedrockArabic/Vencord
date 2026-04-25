/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { AuthenticationStore, FluxDispatcher, RestAPI } from "@webpack/common";

const settings = definePluginSettings({
    enabled: {
        type: OptionType.BOOLEAN,
        description: "Enable auto reaction to new messages",
        default: false,
        restartNeeded: false
    },
    reactionEmoji: {
        type: OptionType.STRING,
        description: "Emoji(s) to react with (single emoji or comma-separated for multiple)",
        default: "👍",
        restartNeeded: false
    },
    randomReaction: {
        type: OptionType.BOOLEAN,
        description: "React with random emoji (disable to react with all emojis)",
        default: false,
        restartNeeded: false
    },
    targetGuildId: {
        type: OptionType.STRING,
        description: "Target Guild ID (right-click server → Copy Server ID)",
        default: "1223509906695520346",
        restartNeeded: false
    },
    targetChannelId: {
        type: OptionType.STRING,
        description: "Target Channel ID(s) (single ID or comma-separated for multiple channels)",
        default: "1225706378673520690",
        restartNeeded: false
    },
    delay: {
        type: OptionType.NUMBER,
        description: "Delay before reacting in milliseconds",
        default: 1000,
        restartNeeded: false
    },
    useSelfbot: {
        type: OptionType.BOOLEAN,
        description: "Use selfbot mode (requires token - more reliable)",
        default: false,
        restartNeeded: false
    },
    selfbotToken: {
        type: OptionType.STRING,
        description: "User account token (get from Discord app/developer tools - NOT bot token)",
        default: "",
        restartNeeded: false,
        dangerous: true
    },
    debugMode: {
        type: OptionType.BOOLEAN,
        description: "Enable debug logging",
        default: true,
        restartNeeded: false
    },
    retryAttempts: {
        type: OptionType.NUMBER,
        description: "Number of retry attempts for failed reactions",
        default: 5,
        restartNeeded: false
    },
    retryDelay: {
        type: OptionType.NUMBER,
        description: "Delay between retry attempts in milliseconds",
        default: 500,
        restartNeeded: false
    }
});

// Global state
let messageListener: any = null;
let selfbotClient: any = null;
let currentUserId: string | null = null;

// Retry tracking
const retryMap = new Map<string, { attempts: number; lastAttempt: number; }>();

// Utility functions
function debugLog(message: string, ...args: any[]) {
    if (settings.store.debugMode) {
        console.log(`[AutoReactor] ${message}`, ...args);
    }
}

function getEmojis(): string[] {
    const emojiString = settings.store.reactionEmoji.trim();
    const emojis = emojiString.split(",")
        .map(emoji => emoji.trim())
        .filter(emoji => emoji.length > 0);
    return emojis.length > 0 ? emojis : ["👍"];
}

function getChannelIds(): string[] {
    const channelString = settings.store.targetChannelId.trim();
    const channels = channelString.split(",")
        .map(channel => channel.trim())
        .filter(channel => channel.length > 0);
    return channels.length > 0 ? channels : ["1225706378673520690"];
}

function getRandomEmoji(): string {
    const emojis = getEmojis();
    if (emojis.length === 1) return emojis[0];

    const randomIndex = Math.floor(Math.random() * emojis.length);
    const selectedEmoji = emojis[randomIndex];
    debugLog(`Selected random emoji: ${selectedEmoji} from [${emojis.join(", ")}]`);
    return selectedEmoji;
}

function isRetryableError(error: any): boolean {
    const retryableCodes = [403, 405, 429, 500, 502, 503, 504];
    const statusCode = error?.status || error?.response?.status;
    return retryableCodes.includes(statusCode);
}

function getRetryKey(messageId: string, emojiIndex: number = 0): string {
    return `${messageId}-${emojiIndex}`;
}

function canRetry(messageId: string, emojiIndex: number = 0): boolean {
    const key = getRetryKey(messageId, emojiIndex);
    const retry = retryMap.get(key);

    if (!retry) {
        retryMap.set(key, { attempts: 0, lastAttempt: Date.now() });
        return true;
    }

    return retry.attempts < settings.store.retryAttempts;
}

function incrementRetry(messageId: string, emojiIndex: number = 0): void {
    const key = getRetryKey(messageId, emojiIndex);
    const retry = retryMap.get(key);
    if (retry) {
        retry.attempts++;
        retry.lastAttempt = Date.now();
    }
}

function clearRetry(messageId: string, emojiIndex: number = 0): void {
    const key = getRetryKey(messageId, emojiIndex);
    retryMap.delete(key);
}

// Selfbot client
async function initializeSelfbot(): Promise<boolean> {
    if (!settings.store.selfbotToken) {
        debugLog("No selfbot token provided");
        return false;
    }

    try {
        selfbotClient = {
            async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
                const response = await fetch(`https://discord.com/api/v9/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`, {
                    method: "PUT",
                    headers: {
                        "Authorization": settings.store.selfbotToken,
                        "Content-Type": "application/json"
                    }
                });

                if (!response.ok) {
                    const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
                    (error as any).status = response.status;
                    throw error;
                }
            }
        };

        debugLog("Selfbot client initialized");
        return true;
    } catch (error) {
        console.error("[AutoReactor] Failed to initialize selfbot:", error);
        return false;
    }
}

// Core reaction function
async function addReaction(messageId: string, channelId: string, emoji: string): Promise<void> {
    if (settings.store.useSelfbot && selfbotClient) {
        await selfbotClient.addReaction(channelId, messageId, emoji);
    } else {
        await RestAPI.put({
            url: `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
            body: {}
        });
    }
}

// Main reaction handler with retry logic
async function reactToMessage(messageId: string, channelId: string, emojiIndex: number = 0): Promise<void> {
    const emojis = getEmojis();
    const emoji = settings.store.randomReaction ? getRandomEmoji() : emojis[emojiIndex];
    const retryKey = getRetryKey(messageId, emojiIndex);

    try {
        // Check if we can retry
        if (!canRetry(messageId, emojiIndex)) {
            debugLog(`Max retry attempts reached for ${messageId} with ${emoji}`);
            return;
        }

        // Increment attempt counter
        incrementRetry(messageId, emojiIndex);

        // Add the reaction
        await addReaction(messageId, channelId, emoji);

        // Success - clear retry counter
        clearRetry(messageId, emojiIndex);

        const mode = settings.store.randomReaction ? "random" : `emoji ${emojiIndex + 1}/${emojis.length}`;
        const method = settings.store.useSelfbot ? "selfbot" : "RestAPI";
        debugLog(`Reacted to message ${messageId} with ${emoji} using ${method} (${mode})`);

        // If not random mode and there are more emojis, continue
        if (!settings.store.randomReaction && emojiIndex < emojis.length - 1) {
            setTimeout(() => {
                reactToMessage(messageId, channelId, emojiIndex + 1);
            }, 200); // Small delay between multiple reactions
        }

    } catch (error: any) {
        debugLog(`Reaction failed for ${messageId} with ${emoji}:`, error);

        if (isRetryableError(error) && canRetry(messageId, emojiIndex)) {
            const retry = retryMap.get(retryKey);
            const nextAttempt = retry ? retry.attempts + 1 : 1;

            debugLog(`Retrying reaction in ${settings.store.retryDelay}ms (attempt ${nextAttempt}/${settings.store.retryAttempts})`);

            setTimeout(() => {
                reactToMessage(messageId, channelId, emojiIndex);
            }, settings.store.retryDelay);
        } else {
            // Max retries reached or non-retryable error
            console.error(`[AutoReactor] Failed to react to message ${messageId} with ${emoji} after all attempts:`, error);
            clearRetry(messageId, emojiIndex);
        }
    }
}

// Message listener setup
function setupMessageListener(): void {
    currentUserId = AuthenticationStore.getId();
    const targetChannels = getChannelIds();

    debugLog("Setting up message listener for user:", currentUserId);
    debugLog("Target guild:", settings.store.targetGuildId);
    debugLog("Target channels:", targetChannels);
    debugLog("Emojis:", getEmojis());
    debugLog("Random mode:", settings.store.randomReaction);

    messageListener = (event: any) => {
        if (!settings.store.enabled) return;

        if (event.type !== "MESSAGE_CREATE") return;

        const { message } = event;

        // Validate message
        if (!message?.id || !message?.guild_id || !message?.channel_id) {
            debugLog("Invalid message structure, skipping");
            return;
        }

        // Check target guild
        if (message.guild_id !== settings.store.targetGuildId) {
            debugLog("Message not in target guild, skipping");
            return;
        }

        // Check if message is in any of the target channels
        if (!targetChannels.includes(message.channel_id)) {
            debugLog(`Message not in target channels (channel: ${message.channel_id}), skipping`);
            return;
        }

        // Skip own messages
        if (message.author?.id === currentUserId) {
            debugLog("Skipping own message");
            return;
        }

        // Skip bot messages
        if (message.author?.bot) {
            debugLog("Skipping bot message");
            return;
        }

        debugLog(`Processing message ${message.id} from ${message.author?.id} in channel ${message.channel_id}`);

        // Start reaction after delay
        setTimeout(() => {
            reactToMessage(message.id, message.channel_id);
        }, settings.store.delay);
    };

    FluxDispatcher.subscribe("MESSAGE_CREATE", messageListener);
    debugLog("Message listener subscribed to MESSAGE_CREATE events");
}

// Plugin definition
export default definePlugin({
    name: "AutoReactor",
    description: "Automatically reacts to new messages in a specific guild and channel (supports both Vencord API and selfbot modes)",
    authors: [Devs.Minato],
    settings,
    patches: [],

    async start() {
        debugLog("Starting plugin...");

        // Log current settings
        debugLog("Settings:", {
            enabled: settings.store.enabled,
            useSelfbot: settings.store.useSelfbot,
            hasToken: !!settings.store.selfbotToken,
            guildId: settings.store.targetGuildId,
            channelIds: getChannelIds(),
            emojis: getEmojis(),
            randomReaction: settings.store.randomReaction,
            delay: settings.store.delay,
            retryAttempts: settings.store.retryAttempts,
            retryDelay: settings.store.retryDelay
        });

        // Initialize selfbot if enabled
        if (settings.store.useSelfbot) {
            const success = await initializeSelfbot();
            if (!success) {
                console.error("[AutoReactor] Failed to initialize selfbot, falling back to RestAPI mode");
            }
        }

        // Setup message listener
        setupMessageListener();
        debugLog("Plugin started successfully");
    },

    stop() {
        debugLog("Stopping plugin...");

        // Unsubscribe from message events
        if (messageListener) {
            FluxDispatcher.unsubscribe("MESSAGE_CREATE", messageListener);
            messageListener = null;
            debugLog("Message listener unsubscribed");
        }

        // Clear selfbot client
        selfbotClient = null;
        debugLog("Selfbot client cleared");

        // Clear retry map
        retryMap.clear();
        debugLog("Retry map cleared");

        // Clear current user ID
        currentUserId = null;

        debugLog("Plugin stopped");
    }
});
