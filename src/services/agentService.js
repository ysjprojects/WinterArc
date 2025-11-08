const { Agent, tool } = require('@openai/agents');

/**
 * ----------------------------------------------------------------
 * Tool Definitions
 * ----------------------------------------------------------------
 * These definitions tell the agent WHAT it can do.
 * The BotController will handle the HOW.
 */

const getTransactionHistory = tool({
  name: 'get_transaction_history',
  description: "Get the current user's transaction history.",
  parameters: {
    type: 'object',
    properties: {},
  },
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
  },
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
    },
});


/**
 * ----------------------------------------------------------------
 * Agent Definition
 * ----------------------------------------------------------------
 */

const arcAssistant = new Agent({
  name: 'Arc Assistant',
  instructions:
    "You are a helpful assistant for the ARC wallet. Your goal is to understand the user's text and decide whether they are asking for information or trying to make a payment.\n" +
    "- If they ask for history, transactions, or past payments, use 'get_transaction_history'.\n" +
    "- If they want to send money (e.g., 'send 10 to bob', 'pay 5 USDC to @alice', 'transfer 2.5 to 0x123'), use 'make_payment'.\n" +
    "- If they want to request money (e.g., 'request 10 from @bob123'), use 'request_payment'.\n" +
    "- For anything else, just provide a helpful chat response.",
  tools: [getTransactionHistory, makePayment, requestPayment],
});

/**
 * ----------------------------------------------------------------
 * Mock Agent Runner
 * ----------------------------------------------------------------
 * This MOCK function simulates the output of the arcAssistant.
 * It returns the action the controller should take.
 */
const runAgent = async (text, user) => {
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
  const historyRegex = /(?:show|get|my)\s+(?:transaction\s+)?(history|transactions|past payments)/i;
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
  arcAssistant,
  runAgent,
};