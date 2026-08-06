"use client";

import * as React from "react";
import type { MembershipRole, AgentTaskStatus } from "@prisma/client";

import type { BoardDTO, AgentTaskDTO } from "@/lib/types";
import { apiFetch, ApiClientError } from "@/lib/client/api";
import type {
  CreateTaskInput,
  UpdateTaskInput,
} from "@/lib/validation/schemas";

/**
 * Board state container. This is the client-side mirror of the authoritative
 * board fetched from Postgres. It exposes mutation helpers that call the REST
 * API and reconcile the returned (authoritative) task back into local state.
 *
 * It is deliberately Liveblocks-agnostic: the board works even when realtime is
 * unconfigured. Liveblocks only calls `refetch()` when it receives an
 * invalidation broadcast.
 */
type BoardContextValue = {
  board: BoardDTO;
  role: MembershipRole;
  currentUserId: string;
  agentEnabled: boolean;
  demoMode: boolean;
  selectedTaskId: string | null;
  selectTask: (id: string | null) => void;
  selectedTask: AgentTaskDTO | null;
  refetch: () => Promise<void>;
  refreshing: boolean;
  createTask: (input: CreateTaskInput) => Promise<AgentTaskDTO>;
  updateTask: (
    taskId: string,
    input: UpdateTaskInput,
  ) => Promise<AgentTaskDTO>;
  moveTask: (
    taskId: string,
    status: AgentTaskStatus,
    expectedVersion: number,
    position?: number,
  ) => Promise<AgentTaskDTO>;
  deleteTask: (taskId: string, expectedVersion: number) => Promise<void>;
};

const BoardContext = React.createContext<BoardContextValue | null>(null);

export function useBoard(): BoardContextValue {
  const ctx = React.useContext(BoardContext);
  if (!ctx) throw new Error("useBoard must be used within a BoardProvider");
  return ctx;
}

export function BoardProvider({
  initialBoard,
  currentUserId,
  agentEnabled,
  demoMode,
  children,
}: {
  initialBoard: BoardDTO;
  currentUserId: string;
  agentEnabled: boolean;
  demoMode: boolean;
  children: React.ReactNode;
}) {
  const [board, setBoard] = React.useState<BoardDTO>(initialBoard);
  const [selectedTaskId, setSelectedTaskId] = React.useState<string | null>(
    null,
  );
  const [refreshing, setRefreshing] = React.useState(false);
  const roomId = initialBoard.room.id;

  const refetch = React.useCallback(async () => {
    setRefreshing(true);
    try {
      const next = await apiFetch<BoardDTO>(`/api/rooms/${roomId}`);
      setBoard(next);
    } catch {
      // Keep the current board on transient failure; a later event will retry.
    } finally {
      setRefreshing(false);
    }
  }, [roomId]);

  const upsertTask = React.useCallback((task: AgentTaskDTO) => {
    setBoard((prev) => {
      const exists = prev.tasks.some((t) => t.id === task.id);
      const tasks = exists
        ? prev.tasks.map((t) => (t.id === task.id ? task : t))
        : [...prev.tasks, task];
      return { ...prev, tasks };
    });
  }, []);

  const createTask = React.useCallback(
    async (input: CreateTaskInput) => {
      const { task } = await apiFetch<{ task: AgentTaskDTO }>(
        `/api/rooms/${roomId}/tasks`,
        { method: "POST", body: JSON.stringify(input) },
      );
      upsertTask(task);
      return task;
    },
    [roomId, upsertTask],
  );

  const updateTask = React.useCallback(
    async (taskId: string, input: UpdateTaskInput) => {
      const { task } = await apiFetch<{ task: AgentTaskDTO }>(
        `/api/tasks/${taskId}`,
        { method: "PATCH", body: JSON.stringify(input) },
      );
      upsertTask(task);
      return task;
    },
    [upsertTask],
  );

  const moveTask = React.useCallback(
    async (
      taskId: string,
      status: AgentTaskStatus,
      expectedVersion: number,
      position?: number,
    ) => {
      // Optimistic: reflect the move immediately so it doesn't wait on a round
      // trip. Rolled back below if the request fails (e.g. a version conflict).
      let previous: AgentTaskDTO | undefined;
      setBoard((prev) => {
        previous = prev.tasks.find((t) => t.id === taskId);
        return {
          ...prev,
          tasks: prev.tasks.map((t) =>
            t.id === taskId ? { ...t, status } : t,
          ),
        };
      });
      try {
        const { task } = await apiFetch<{ task: AgentTaskDTO }>(
          `/api/tasks/${taskId}/move`,
          {
            method: "POST",
            body: JSON.stringify({ status, expectedVersion, position }),
          },
        );
        upsertTask(task);
        return task;
      } catch (err) {
        if (previous) upsertTask(previous);
        throw err;
      }
    },
    [upsertTask],
  );

  const deleteTask = React.useCallback(
    async (taskId: string, expectedVersion: number) => {
      // expectedVersion is not enforced on delete server-side in Stage 1, but
      // we keep the signature symmetric for a future conditional delete.
      void expectedVersion;
      await apiFetch(`/api/tasks/${taskId}`, { method: "DELETE" });
      setBoard((prev) => ({
        ...prev,
        tasks: prev.tasks.filter((t) => t.id !== taskId),
      }));
      setSelectedTaskId((cur) => (cur === taskId ? null : cur));
    },
    [],
  );

  const selectedTask =
    board.tasks.find((t) => t.id === selectedTaskId) ?? null;

  const value: BoardContextValue = {
    board,
    role: board.room.role,
    currentUserId,
    agentEnabled,
    demoMode,
    selectedTaskId,
    selectTask: setSelectedTaskId,
    selectedTask,
    refetch,
    refreshing,
    createTask,
    updateTask,
    moveTask,
    deleteTask,
  };

  return (
    <BoardContext.Provider value={value}>{children}</BoardContext.Provider>
  );
}

export { ApiClientError };
