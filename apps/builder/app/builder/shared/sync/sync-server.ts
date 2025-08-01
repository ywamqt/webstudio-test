import { useEffect } from "react";
import { atom } from "nanostores";
import type { Change } from "immerhin";
import type { Project } from "@webstudio-is/project";
import type { Build } from "@webstudio-is/project-build";
import type { AuthPermit } from "@webstudio-is/trpc-interface/index.server";
import * as commandQueue from "./command-queue";
import { restPatchPath } from "~/shared/router-utils";
import { toast } from "@webstudio-is/design-system";
import { fetch } from "~/shared/fetch.client";
import type { SyncStorage, Transaction } from "~/shared/sync-client";
import { $project } from "~/shared/nano-states";
import { loadBuilderData } from "~/shared/builder-data";

// Periodic check for new entries to group them into one job/call in sync queue.
const NEW_ENTRIES_INTERVAL = 1000;

// First attempts we will simply retry without changing the state or notifying anyone.
const INTERVAL_RECOVERY = 2000;

// After this amount of retries without success, we consider connection status error.
const MAX_RETRY_RECOVERY = 5;

// We are assuming that error is fatal (unrecoverable) after this amount of attempts with API error.
const MAX_ALLOWED_API_ERRORS = 5;

// When we reached max failed attempts we will slow down the attempts interval.
const INTERVAL_ERROR = 5000;
const MAX_INTERVAL_ERROR = 2 * 60000;

const pause = (timeout: number) => {
  return new Promise((resolve) => setTimeout(resolve, timeout));
};

export type QueueStatus =
  | { status: "running" }
  | { status: "idle" }
  | { status: "recovering" }
  | { status: "failed" }
  | { status: "fatal"; error: string };

export const $queueStatus = atom<QueueStatus>({ status: "idle" });

const getRandomBetween = (a: number, b: number) => {
  return Math.random() * (b - a) + a;
};
// polling is important to queue new transactions independently
// from async iterator and batch them into single job
const pollCommands = async function* () {
  while (true) {
    const commands = commandQueue.dequeueAll();
    if (commands.length > 0) {
      $queueStatus.set({ status: "running" });
      yield* commands;
      await pause(NEW_ENTRIES_INTERVAL);
      // Do not switch on idle state until there is possibility that queue is not empty
      continue;
    }
    $queueStatus.set({ status: "idle" });
    await pause(NEW_ENTRIES_INTERVAL);
  }
};

const retry = async function* () {
  let failedAttempts = 0;
  let delay = INTERVAL_ERROR;

  while (true) {
    yield;
    failedAttempts += 1;
    if (failedAttempts < MAX_RETRY_RECOVERY) {
      $queueStatus.set({ status: "recovering" });
      await pause(INTERVAL_RECOVERY);
    } else {
      $queueStatus.set({ status: "failed" });

      // Clamped exponential backoff with decorrelated jitter
      // to prevent clients from sending simultaneous requests after server issues
      delay = getRandomBetween(INTERVAL_ERROR, delay * 3);
      delay = Math.min(delay, MAX_INTERVAL_ERROR);

      toast.error(
        `Builder is offline. Retry in ${Math.round(delay / 1000)} seconds.`
      );

      await pause(delay);
    }
  }
};

let syncServerIsRunning = false;

const syncServer = async function () {
  if (syncServerIsRunning) {
    return;
  }

  syncServerIsRunning = true;

  const detailsMap = new Map<
    Project["id"],
    { version: number; buildId: Build["id"]; authToken: string | undefined }
  >();

  polling: for await (const command of pollCommands()) {
    if (command.type === "setDetails") {
      // At this moment we can be sure that all transactions for the command.projectId is already synchronized
      // There are 2 options
      // - Project opened again before transactions synchronized,
      //   in that case project is outdated and we need to ask user to reload it.
      // - Project opened after sync, everything is ok.
      if (command.version < (detailsMap.get(command.projectId)?.version ?? 0)) {
        const error =
          "The project is outdated. Synchronization was incomplete when the project was opened. " +
          "Please reload the page to get the latest version.";
        const shouldReload = confirm(error);

        if (shouldReload) {
          location.reload();
        }

        // stop synchronization and wait til user reload
        $queueStatus.set({ status: "fatal", error });

        if (shouldReload === false) {
          toast.error(
            "Synchronization has been paused. Please reload to continue.",
            { id: "outdated-error", duration: Number.POSITIVE_INFINITY }
          );
        }

        break polling;
      }

      detailsMap.set(command.projectId, {
        version: command.version,
        buildId: command.buildId,
        authToken: command.authToken,
      });
      continue;
    }

    const { projectId, transactions } = command;
    const details = detailsMap.get(projectId);

    if (details === undefined) {
      const error =
        "Project details not found. Synchronization has been paused. Please reload to continue.";

      toast.error(error, {
        id: "details-error",
        duration: Number.POSITIVE_INFINITY,
      });

      $queueStatus.set({ status: "fatal", error });

      return;
    }

    // We don't know how to handle api errors. Like parsing errors, etc.
    // Let
    let apiErrorCount = 0;

    for await (const _ of retry()) {
      // in case of any error continue retrying
      try {
        const headers = new Headers();
        if (details.authToken) {
          headers.append("x-auth-token", details.authToken);
        }
        const response = await fetch(restPatchPath(), {
          method: "post",
          body: JSON.stringify({
            transactions,
            buildId: details.buildId,
            projectId,
            // provide latest stored version to server
            version: details.version,
            headers,
          }),
        });

        if (response.ok) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = (await response.json()) as any;
          if (result.status === "ok") {
            details.version += 1;
            // stop retrying and wait next transactions
            continue polling;
          }
          // when versions mismatched ask user to reload
          // user may cancel to copy own state before reloading
          if (
            result.status === "version_mismatched" ||
            result.status === "authorization_error"
          ) {
            const error =
              result.errors ?? "Unknown version mismatch. Please reload.";

            const shouldReload = confirm(error);
            if (shouldReload) {
              location.reload();
            }

            $queueStatus.set({ status: "fatal", error });

            if (shouldReload === false) {
              toast.error(
                "Synchronization has been paused. Please reload to continue.",
                { duration: Number.POSITIVE_INFINITY }
              );
            }

            // stop synchronization and wait til user reload
            break polling;
          }

          if (apiErrorCount >= MAX_ALLOWED_API_ERRORS) {
            const error = `Fatal error. ${
              result.errors ?? JSON.stringify(result.errors)
            } Synchronization has been paused.`;
            // Api error we don't know how to handle, as retries will not help probably
            // We should show error and break synchronization
            $queueStatus.set({ status: "fatal", error });

            toast.error(error, {
              id: "fatal-error",
              duration: Number.POSITIVE_INFINITY,
            });

            break polling;
          }

          apiErrorCount += 1;
        } else {
          // Various 500 responses, from proxies etc
          // It's usually ok to be here, probably restorable with retries
          const text = await response.text();
          // To investigate some strange errors we have seen

          console.info(`Non ok respone: ${text}`);
        }
      } catch (error) {
        if (navigator.onLine) {
          // ERR_CONNECTION_REFUSED or like, probably restorable with retries
          // anyway lets's log it

          console.info(
            error instanceof Error ? error.message : JSON.stringify(error)
          );
        }
      }
    }
  }
};

export const startProjectSync = ({
  projectId,
  buildId,
  version,
  authPermit,
  authToken,
}: {
  buildId: Build["id"];
  projectId: Project["id"];
  authToken: string | undefined;
  version: number;
  authPermit: AuthPermit;
}) => {
  if (authPermit === "view") {
    return;
  }
  commandQueue.enqueue({
    type: "setDetails",
    projectId,
    buildId,
    version,
    authToken,
  });
};

const useSyncProject = ({
  projectId,
  authPermit,
}: {
  projectId: Project["id"];
  authPermit: AuthPermit;
}) => {
  useEffect(() => {
    if (authPermit === "view") {
      return;
    }
    syncServer();
  }, [projectId, authPermit]);
};

export class ServerSyncStorage implements SyncStorage {
  name = "server";
  sendTransaction(transaction: Transaction<Change[]>) {
    if (transaction.object === "server") {
      const projectId = $project.get()?.id ?? "";
      commandQueue.enqueue({
        type: "transactions",
        transactions: [transaction],
        projectId,
      });
    }
  }
  subscribe(setState: (state: unknown) => void, signal: AbortSignal) {
    const projectId = $project.get()?.id ?? "";
    loadBuilderData({ projectId, signal })
      .then((data) => {
        const serverData = new Map(Object.entries(data));
        setState(new Map([["server", serverData]]));
      })
      .catch((err) => {
        if (err instanceof Error) {
          console.error(err);
          return;
        }

        // Abort error do nothing
      });
  }
}

/**
 * Promisify idle state of the queue for a one-off notification when everything is saved.
 */
export const isSyncIdle = () => {
  return new Promise<QueueStatus>((resolve, reject) => {
    const handle = (status: QueueStatus) => {
      if (status.status === "idle") {
        resolve(status);
        return true;
      }
      if (status.status === "fatal") {
        reject(
          new Error(
            "Synchronization is in fatal state. Please reload the page or check your internet connection."
          )
        );
        return true;
      }
      return false;
    };
    const status = $queueStatus.get();

    if (handle(status) === false) {
      const unsubscribe = $queueStatus.subscribe((status) => {
        if (handle(status)) {
          unsubscribe();
        }
      });
    }
  });
};

type SyncServerProps = {
  projectId: Project["id"];
  authPermit: AuthPermit;
};

export const useSyncServer = ({ projectId, authPermit }: SyncServerProps) => {
  useSyncProject({
    projectId,
    authPermit,
  });

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      const { status } = $queueStatus.get();
      if (status === "idle" || status === "fatal") {
        return;
      }
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);
};
