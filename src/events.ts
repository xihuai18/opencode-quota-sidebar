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
  onTuiActivity: () => Promise<void>
  onTuiSessionSelect: (sessionID: string) => Promise<void>
  onMessageRemoved: (info: {
    sessionID: string
    messageID?: string
  }) => Promise<void>
  onAssistantMessageCompleted: (message: AssistantMessage) => Promise<void>
}) {
  return async (event: Event) => {
    const tui = event as unknown as {
      type: string
      properties?: { sessionID?: string }
    }

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

    if (tui.type === 'tui.prompt.append' || tui.type === 'tui.command.execute') {
      await handlers.onTuiActivity()
      return
    }

    if (tui.type === 'tui.session.select') {
      if (typeof tui.properties?.sessionID !== 'string') return
      await handlers.onTuiSessionSelect(tui.properties.sessionID)
      await handlers.onTuiActivity()
      return
    }

    if (event.type === 'message.removed') {
      const props = event.properties as {
        sessionID: string
        messageID?: string
      }
      await handlers.onMessageRemoved({
        sessionID: props.sessionID,
        messageID:
          typeof props.messageID === 'string' ? props.messageID : undefined,
      })
      return
    }

    if (event.type !== 'message.updated') return
    if (!isAssistantMessage(event.properties.info)) return
    const completed = event.properties.info.time.completed
    if (typeof completed !== 'number' || !Number.isFinite(completed)) return
    await handlers.onAssistantMessageCompleted(event.properties.info)
  }
}
