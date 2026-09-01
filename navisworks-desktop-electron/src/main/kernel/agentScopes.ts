import { token, type Scope } from './kernel'

export const ConversationScopeToken = token<Scope>('agent.conversationScope')
export const DocumentScopeToken = token<Scope>('agent.documentScope')

/** Owns orthogonal Conversation/Document scopes and short-lived Run scopes. */
export class AgentScopeManager {
  readonly #conversations = new Map<string, Promise<Scope>>()
  readonly #documents = new Map<string, Promise<Scope>>()

  constructor(private readonly appScope: Scope) {}

  async createRun(
    runId: string,
    conversationId: string,
    documentInstanceId?: string | null,
  ): Promise<Scope> {
    const [conversation, document] = await Promise.all([
      this.#getConversation(conversationId),
      documentInstanceId ? this.#getDocument(documentInstanceId) : Promise.resolve(undefined),
    ])
    const run = await this.appScope.createChild('run', runId)
    run.register(ConversationScopeToken, conversation)
    if (document !== undefined) run.register(DocumentScopeToken, document)
    return run
  }

  async forgetConversation(conversationId: string): Promise<void> {
    const pending = this.#conversations.get(conversationId)
    this.#conversations.delete(conversationId)
    if (pending !== undefined) await (await pending).dispose()
  }

  async forgetDocument(documentInstanceId: string): Promise<void> {
    const pending = this.#documents.get(documentInstanceId)
    this.#documents.delete(documentInstanceId)
    if (pending !== undefined) await (await pending).dispose()
  }

  #getConversation(conversationId: string): Promise<Scope> {
    const existing = this.#conversations.get(conversationId)
    if (existing !== undefined) return existing
    const created = this.appScope.createChild('conversation', conversationId)
    this.#conversations.set(conversationId, created)
    return created
  }

  #getDocument(documentInstanceId: string): Promise<Scope> {
    const existing = this.#documents.get(documentInstanceId)
    if (existing !== undefined) return existing
    const created = this.appScope.createChild('document', documentInstanceId)
    this.#documents.set(documentInstanceId, created)
    return created
  }
}
