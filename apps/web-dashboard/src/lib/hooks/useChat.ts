"use client";

import { useState, useCallback, useRef } from "react";
import {
  sendChat,
  createSession,
  sendSessionChat,
  getSession,
  listSessions,
  deleteSession as apiDeleteSession,
  updateSessionTitle,
} from "../api";
import type { ChatMessage, SessionInfo } from "../types";

let messageCounter = 0;

function createId(): string {
  return `msg-${Date.now()}-${++messageCounter}`;
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const sessionIdRef = useRef<string | null>(null);

  const refreshSessions = useCallback(async () => {
    try {
      const data = await listSessions();
      setSessions(data.sessions);
    } catch {
      // Silently fail — sessions are a nice-to-have
    }
  }, []);

  const loadSession = useCallback(async (id: string) => {
    try {
      const detail = await getSession(id);
      setSessionId(id);
      sessionIdRef.current = id;
      setMessages(
        detail.messages.map((m) => ({
          id: createId(),
          role: m.role as "user" | "assistant" | "system",
          content: m.content,
        }))
      );
    } catch (err) {
      console.error("Failed to load session:", err);
    }
  }, []);

  const deleteSessionById = useCallback(
    async (id: string) => {
      try {
        await apiDeleteSession(id);
        setSessions((prev) => prev.filter((s) => s.id !== id));
        if (sessionIdRef.current === id) {
          setSessionId(null);
          sessionIdRef.current = null;
          setMessages([]);
        }
      } catch (err) {
        console.error("Failed to delete session:", err);
      }
    },
    []
  );

  const renameSession = useCallback(
    async (id: string, title: string) => {
      try {
        const updated = await updateSessionTitle(id, title);
        setSessions((prev) =>
          prev.map((s) => (s.id === id ? { ...s, title: updated.title } : s))
        );
      } catch (err) {
        console.error("Failed to rename session:", err);
      }
    },
    []
  );

  const sendMessage = useCallback(
    async (content: string, model: string) => {
      const userMessage: ChatMessage = {
        id: createId(),
        role: "user",
        content,
      };

      const assistantMessage: ChatMessage = {
        id: createId(),
        role: "assistant",
        content: "",
      };

      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setIsStreaming(true);

      try {
        let response: Response;

        // If we have a session, use session chat (messages are managed server-side)
        if (sessionIdRef.current) {
          response = await sendSessionChat(sessionIdRef.current, {
            message: content,
            stream: true,
          });
        } else {
          // No session yet — create one, then use session chat
          const session = await createSession({
            model,
            title: content.slice(0, 80),
          });
          setSessionId(session.id);
          sessionIdRef.current = session.id;

          response = await sendSessionChat(session.id, {
            message: content,
            stream: true,
          });

          // Refresh session list
          refreshSessions();
        }

        if (!response.body) {
          throw new Error("No response body");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                setMessages((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last && last.role === "assistant") {
                    updated[updated.length - 1] = {
                      ...last,
                      content: last.content + delta,
                    };
                  }
                  return updated;
                });
              }
            } catch {
              // Skip malformed chunks
            }
          }
        }
      } catch (err) {
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last && last.role === "assistant" && !last.content) {
            updated[updated.length - 1] = {
              ...last,
              content: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
            };
          }
          return updated;
        });
      } finally {
        setIsStreaming(false);
      }
    },
    [messages, refreshSessions]
  );

  const clearMessages = useCallback(() => {
    setMessages([]);
    setSessionId(null);
    sessionIdRef.current = null;
  }, []);

  return {
    messages,
    setMessages,
    isStreaming,
    sendMessage,
    clearMessages,
    // Session management
    sessionId,
    sessions,
    refreshSessions,
    loadSession,
    deleteSession: deleteSessionById,
    renameSession,
  };
}
