import type { ChatStoreLeaseStatus } from './chatStoreLease';
import type { AgentId } from '../types';

export interface ConversationSessionOwner {
  sessionId: string;
  conversationId: string;
  agentId: AgentId;
  runId: string;
  claimedAt: number;
}

export class ConversationStoreCorruptError extends Error {
  constructor(message = 'The persisted conversation store is corrupt; no data was changed.') {
    super(message);
    this.name = 'ConversationStoreCorruptError';
  }
}

export class ConversationStoreAtomicWriteError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConversationStoreAtomicWriteError';
  }
}

export class ConversationRevisionConflictError extends Error {
  constructor(
    readonly conversationId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`Conversation ${conversationId} revision changed from ${expectedRevision} to ${actualRevision}.`);
    this.name = 'ConversationRevisionConflictError';
  }
}

export class ConversationTurnStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationTurnStateError';
  }
}

export class ConversationSessionConflictError extends ConversationTurnStateError {
  constructor(readonly existingOwner: ConversationSessionOwner) {
    super(
      `Runtime session ${existingOwner.sessionId} is already owned by `
      + `${existingOwner.conversationId}/${existingOwner.agentId}/${existingOwner.runId}.`,
    );
    this.name = 'ConversationSessionConflictError';
  }
}

export class ConversationStoreReadOnlyError extends Error {
  constructor(readonly status: ChatStoreLeaseStatus) {
    super(status.ownerInstanceId
      ? `Conversation writes are owned by studio instance ${status.ownerInstanceId}.`
      : 'This studio instance has not acquired the conversation writer lease.');
    this.name = 'ConversationStoreReadOnlyError';
  }
}

export class ConversationStoreMigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConversationStoreMigrationError';
  }
}
