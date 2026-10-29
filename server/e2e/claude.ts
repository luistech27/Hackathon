import type Anthropic from '@anthropic-ai/sdk'
import type { AgentConfig } from '../src/agent/agent.ts'

type Message = Anthropic.Beta.Messages.BetaMessage

interface Offer {
  offerId: number
  supplierId: number
  supplier: string
  leadTimeDays: number
  maxPacks: number
}

interface Briefing {
  suppliesToRestock: { product: string; daysLeft: number | null; offers: Offer[] }[]
}

// A stand-in for Claude in the end-to-end tests: asked about a greenhouse, it orders the first supply to
// restock from its fastest offer, enough to fill the container; told the result, it sums up. The code
// around it (forecast, prices, approval rules, payments) is the real one.
export function scriptedClaude(): AgentConfig {
  return {
    model: 'claude-e2e',
    createMessage: async (params) => {
      const last = params.messages.at(-1)
      if (typeof last?.content !== 'string') return reply([{ type: 'text', text: 'Ordered what was running low.' }], 'end_turn')
      const briefing = JSON.parse(last.content.slice(last.content.indexOf('\n') + 1)) as Briefing
      const supply = briefing.suppliesToRestock[0]
      const offer = supply?.offers.toSorted((a, b) => a.leadTimeDays - b.leadTimeDays)[0]
      if (!supply || !offer) return reply([{ type: 'text', text: 'Nothing I can order.' }], 'end_turn')
      const input = {
        supplierId: offer.supplierId,
        items: [{ offerId: offer.offerId, packs: offer.maxPacks }],
        reasoning: `${supply.product} lasts ${supply.daysLeft ?? 0} days and ${offer.supplier} delivers in ${offer.leadTimeDays}.`
      }
      return reply([{ type: 'tool_use', id: 'order-1', name: 'place_order', input }], 'tool_use')
    }
  }
}

const reply = (content: unknown[], stopReason: 'end_turn' | 'tool_use'): Message =>
  ({
    id: 'msg-e2e',
    type: 'message',
    role: 'assistant',
    model: 'claude-e2e',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 }
  }) as unknown as Message
