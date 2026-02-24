import type {
  AssistantMessage,
  Event,
  Message,
  Session,
} from '@opencode-ai/sdk'

function isAssistantMessage(message: Message): message is AssistantMessage {
  return message.role === 'assistant'
}

export function createEventDispatcher(handlers: {
  onSessionCreated: (session: Session) => Promise<void>
  onSessionUpdated: (session: Session) => Promise<void>
  onSessionDeleted: (session: Session) => Promise<void>
  onMessageRemoved: (sessionID: string) => Promise<void>
  onAssistantMessageCompleted: (message: AssistantMessage) => Promise<void>
}) {
  return async (event: Event) => {
    if (event.type === 'session.created') {
      await handlers.onSessionCreated(event.properties.info)
      return
    }

    if (event.type === 'session.updated') {
      await handlers.onSessionUpdated(event.properties.info)
      return
    }

    if (event.type === 'session.deleted') {
      await handlers.onSessionDeleted(event.properties.info)
      return
    }

    if (event.type === 'message.removed') {
      await handlers.onMessageRemoved(event.properties.sessionID)
      return
    }

    if (event.type !== 'message.updated') return
    if (!isAssistantMessage(event.properties.info)) return
    const completed = event.properties.info.time.completed
    if (typeof completed !== 'number' || !Number.isFinite(completed)) return
    await handlers.onAssistantMessageCompleted(event.properties.info)
  }
}
