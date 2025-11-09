const { Agent, tool, run } = require('@openai/agents');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * ----------------------------------------------------------------
 * Create Agent Service Factory
 * ----------------------------------------------------------------
 * Creates agent with executable tools that have access to services
 */

function createAgentService(botController) {
  // Store the last tool call for the controller to access
  let lastToolCall = null;
  
  const getTransactionHistory = tool({
    name: 'get_transaction_history',
    description: "Get the current user's transaction history.",
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    execute: async () => {
      lastToolCall = { type: 'tool_call', toolName: 'get_transaction_history', arguments: {} };
      return 'Getting your transaction history...';
    }
  });

  const makePayment = tool({
    name: 'make_payment',
    description: 'Initiate a USDC payment to a given address, telegram username, or friend alias with a specific amount.',
    parameters: {
      type: 'object',
      properties: {
        recipient: { type: 'string', description: 'The recipient: EVM address (e.g., 0x...), telegram username (e.g., @bob), or friend alias (e.g., bob)' },
        amount: { type: 'number', description: 'The amount of USDC to send' },
      },
      required: ['recipient', 'amount'],
      additionalProperties: false,
    },
    execute: async ({ recipient, amount }) => {
      lastToolCall = { type: 'tool_call', toolName: 'make_payment', arguments: { recipient, amount } };
      return `Sending ${amount} USDC to ${recipient}...`;
    }
  });

  const requestPayment = tool({
    name: 'request_payment',
    description: 'Request a payment from a given address, a telegram username, or a friend alias with a specific amount.',
    parameters: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'The recipient EVM address (e.g., 0x...), a telegram username (e.g., @bob123), or a friend alias (e.g., bob)' },
        amount: { type: 'number', description: 'The amount of USDC to send' },
      },
      required: ['address', 'amount'],
      additionalProperties: false,
    },
    execute: async ({ address, amount }) => {
      lastToolCall = { type: 'tool_call', toolName: 'request_payment', arguments: { address, amount } };
      return `Requesting ${amount} USDC from ${address}...`;
    }
  });


  const arcAssistant = new Agent({
    name: 'Arc Assistant',
    instructions:
      "You are an ARC wallet assistant. When users ask for specific actions, IMMEDIATELY use the appropriate tool without any additional questions or explanations.\n\n" +
      "RULES:\n" +
      "1. History requests (show history, transaction history, who sent money, etc.) → IMMEDIATELY call get_transaction_history\n" +
      "2. Send money (send X to Y, pay X to Y, transfer X to Y) → IMMEDIATELY call make_payment\n" +
      "3. Request money (request X from Y) → IMMEDIATELY call request_payment\n\n" +
      "DO NOT:\n" +
      "- Ask follow-up questions\n" +
      "- Ask for clarification\n" +
      "- Ask about timeframes or filters\n" +
      "- Provide explanations before using tools\n\n" +
      "JUST USE THE TOOL IMMEDIATELY when the user's intent is clear.",
    tools: [getTransactionHistory, makePayment, requestPayment],
    model: 'gpt-5-mini',
    apiKey: config.openai.apiKey,
  });

  // Helper function to access and reset lastToolCall
  const getLastToolCall = () => {
    if (lastToolCall) {
      const result = { ...lastToolCall };
      lastToolCall = null; // Reset for next call
      return result;
    }
    return null;
  };

  return { arcAssistant, runAgent: createRunAgent(arcAssistant, getLastToolCall) };
}

function createRunAgent(arcAssistant, getLastToolCall) {
  return async (text, user) => {
    try {
      if (!config.openai.apiKey) {
        logger.warn('OpenAI API key not configured, falling back to mock agent');
        return runAgentMock(text, user);
      }

      logger.info('Running real OpenAI agent', { text });
      
      // Use the run function from the SDK - tools will execute automatically
      const response = await run(arcAssistant, text);
      
      logger.info('Raw OpenAI response', { 
        finalOutput: response.finalOutput,
        messageCount: response.messages?.length,
        hasToolCalls: response.messages?.some(msg => msg.tool_calls?.length > 0),
        lastMessage: response.messages?.[response.messages.length - 1]
      });
      
      // Check if a tool was executed (stored in lastToolCall)
      const toolCall = getLastToolCall();
      if (toolCall) {
        logger.info('Tool was called by agent', { toolCall });
        return toolCall;
      }
      
      // If no tools were called, return the chat response
      return {
        type: 'chat_response',
        content: response.finalOutput || "I'm not sure how to help with that."
      };
      
    } catch (error) {
      logger.error('Agent execution failed, falling back to mock', {
        error: error.message,
        stack: error.stack,
        text: text.substring(0, 50)
      });
      
      // Fallback to mock agent if real agent fails
      return runAgentMock(text, user);
    }
  };
}

/**
 * ----------------------------------------------------------------
 * Mock Agent Runner (Backup)
 * ----------------------------------------------------------------
 * This MOCK function simulates the output of the arcAssistant.
 * It returns the action the controller should take.
 */
const runAgentMock = async (text, user) => {
  // --- This is a MOCK to simulate the agent's decision ---

  // 1. Handle the "second query" for history summarization
  if (text.includes("Here is the user's transaction history")) {
    if (text.includes('No transactions found')) {
      return {
        type: 'chat_response',
        content: "It looks like you don't have any transactions yet.",
      };
    }
    // Find the pre-formatted text and return it
    const historyBlock = text.split('\n\n').slice(1).join('\n\n');
    return {
      type: 'chat_response',
      content: `Here's your recent transaction history:\n\n${historyBlock}`,
    };
  }

  // 2. Handle payment request
  // Enhanced regex to support multiple formats:
  // - "send 10 to bob", "pay 5 to @alice", "transfer 2.5 USDC to 0x..."
  // - "pay 0.1 bob" (command style without "to")
  const paymentRegex1 = /(?:send|pay|transfer)\s+(\d+(?:\.\d+)?)(?:\s+usdc)?\s+to\s+([a-zA-Z0-9_@][a-zA-Z0-9_]*|0x[a-fA-F0-9]{40})/i;
  const paymentRegex2 = /(?:pay|send|transfer)\s+(\d+(?:\.\d+)?)(?:\s+usdc)?\s+([a-zA-Z0-9_@][a-zA-Z0-9_]*|0x[a-fA-F0-9]{40})/i;
  
  let paymentMatch = text.match(paymentRegex1) || text.match(paymentRegex2);
  if (paymentMatch) {
    return {
      type: 'tool_call',
      toolName: 'make_payment',
      arguments: {
        amount: parseFloat(paymentMatch[1]),
        recipient: paymentMatch[2],
      },
    };
  }

  // 3. Handle history request
  const historyRegex = /(?:show|get|my|who.*sent|payment|transaction)\s*(?:history|transactions|past payments|money|activity)|who.*(?:sent|paid|transferred|transacted)/i;
  const historyMatch = text.match(historyRegex);
  if (historyMatch) {
    return {
      type: 'tool_call',
      toolName: 'get_transaction_history',
      arguments: {},
    };
  }

  // 4. Default fallback
  return {
    type: 'chat_response',
    content: "I'm not sure how to help with that. You can ask me to:\n• 'send 10 to bob' (or @username, address)\n• 'show me my history'\n• 'pay 5 USDC to alice'",
  };
};

module.exports = {
  createAgentService,
  runAgentMock,
};