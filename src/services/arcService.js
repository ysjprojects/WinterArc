const { ethers } = require('ethers');
const config = require('../config');
const logger = require('../utils/logger');
const { ARCError, InsufficientFundsError, ExternalServiceError } = require('../utils/errors');

// USDC ABI for basic transfer operations
const USDC_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)'
];

class ARCService {
  constructor() {
    this.provider = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 5000;
    
    // ARC network configuration
    this.USDC_CONTRACT_ADDRESS = '0x3600000000000000000000000000000000000000';
    this.CHAIN_ID = parseInt(config.arc.chainId);
    
    // Transaction memo storage (in production, use a database)
    this.transactionMemos = new Map(); // txHash -> memo
  }

  async connect() {
    try {
      this.provider = new ethers.JsonRpcProvider(config.arc.rpcUrl, {
        chainId: this.CHAIN_ID,
        name: 'arc-testnet'
      });

      // Test connection
      await this.provider.getNetwork();
      this.isConnected = true;
      this.reconnectAttempts = 0;
      
      logger.info('Connected to ARC network', {
        rpcUrl: config.arc.rpcUrl,
        chainId: this.CHAIN_ID
      });

      return true;
    } catch (error) {
      logger.error('Failed to connect to ARC network', {
        error: error.message,
        rpcUrl: config.arc.rpcUrl
      });
      throw new ExternalServiceError('ARC', error);
    }
  }

  async _handleDisconnection() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    logger.info('Attempting to reconnect to ARC network', {
      attempt: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts
    });

    setTimeout(async () => {
      try {
        await this.connect();
      } catch (error) {
        logger.error('Reconnection attempt failed', {
          attempt: this.reconnectAttempts,
          error: error.message
        });
      }
    }, this.reconnectDelay * this.reconnectAttempts);
  }

  async disconnect() {
    try {
      if (this.provider) {
        this.provider = null;
        this.isConnected = false;
        logger.info('Disconnected from ARC network');
      }
    } catch (error) {
      logger.error('Error disconnecting from ARC network', {
        error: error.message
      });
    }
  }

  generateWallet() {
    try {
      const wallet = ethers.Wallet.createRandom();
      
      logger.info('Generated new EVM wallet for ARC', {
        address: wallet.address
      });

      return {
        address: wallet.address,
        privateKey: wallet.privateKey,
        publicKey: wallet.publicKey,
        mnemonic: wallet.mnemonic?.phrase
      };
    } catch (error) {
      logger.error('Failed to generate EVM wallet', {
        error: error.message
      });
      throw new ARCError('Failed to generate wallet');
    }
  }

  async getUSDCBalance(address) {
    try {
      if (!this.isConnected) {
        throw new ARCError('Not connected to ARC network');
      }

      const usdcContract = new ethers.Contract(
        this.USDC_CONTRACT_ADDRESS,
        USDC_ABI,
        this.provider
      );

      const balance = await usdcContract.balanceOf(address);
      
      // USDC has 6 decimals as ERC-20, but 18 decimals natively
      const formattedBalance = ethers.formatUnits(balance, 6);
      
      logger.debug('Retrieved USDC balance', {
        address,
        balance: formattedBalance
      });

      return parseFloat(formattedBalance);
    } catch (error) {
      logger.error('Failed to get USDC balance', {
        address,
        error: error.message
      });
      throw new ARCError(`Failed to get balance: ${error.message}`);
    }
  }

  async getETHBalance(address) {
    try {
      if (!this.isConnected) {
        throw new ARCError('Not connected to ARC network');
      }

      const balance = await this.provider.getBalance(address);
      const formattedBalance = ethers.formatEther(balance);
      
      logger.debug('Retrieved ETH balance (should be 0 on ARC)', {
        address,
        balance: formattedBalance
      });

      return parseFloat(formattedBalance);
    } catch (error) {
      logger.error('Failed to get ETH balance', {
        address,
        error: error.message
      });
      throw new ARCError(`Failed to get ETH balance: ${error.message}`);
    }
  }

  async getAllBalances(address) {
    try {
      const [usdcBalance] = await Promise.all([
        this.getUSDCBalance(address)
      ]);

      return {
        usdc: usdcBalance
      };
    } catch (error) {
      logger.error('Failed to get all balances', {
        address,
        error: error.message
      });
      throw error;
    }
  }

  async sendUSDCPayment(senderPrivateKey, receiverAddress, amount, memo = null) {
    try {
      logger.info('USDC payment starting', { receiverAddress, amount, memo: !!memo });
      
      if (!this.isConnected) {
        logger.error('ARC not connected');
        throw new ARCError('Not connected to ARC network');
      }

      logger.info('Creating sender wallet from private key');
      const senderWallet = new ethers.Wallet(senderPrivateKey, this.provider);
      logger.info('Sender wallet created', { address: senderWallet.address });
      
      // Check sender USDC balance first
      logger.info('Checking sender USDC balance');
      const senderBalance = await this.getUSDCBalance(senderWallet.address);
      const amountToSend = parseFloat(amount);
      
      logger.info('Balance check completed', { 
        senderBalance, 
        amountToSend,
        hasEnoughFunds: senderBalance >= amountToSend
      });
      
      if (senderBalance < amountToSend) {
        logger.error('Insufficient USDC funds detected', { senderBalance, amountToSend });
        throw new InsufficientFundsError(amountToSend, senderBalance, 'USDC');
      }

      // Estimate gas
      const usdcContract = new ethers.Contract(
        this.USDC_CONTRACT_ADDRESS,
        USDC_ABI,
        senderWallet
      );

      const transferAmount = ethers.parseUnits(amount.toString(), 6); // USDC has 6 decimals

      logger.info('Estimating gas for USDC transfer');
      const gasEstimate = await usdcContract.transfer.estimateGas(receiverAddress, transferAmount);
      const gasPrice = await this.provider.getFeeData();
      
      logger.info('Gas estimation completed', { 
        gasEstimate: gasEstimate.toString(),
        gasPrice: gasPrice.gasPrice?.toString()
      });

      // Prepare and send transaction
      logger.info('Sending USDC transfer transaction');
      const tx = await usdcContract.transfer(receiverAddress, transferAmount, {
        gasLimit: gasEstimate * 120n / 100n, // Add 20% buffer
      });

      logger.info('Transaction sent, waiting for confirmation', { hash: tx.hash });
      
      // Wait for transaction to be mined
      const receipt = await tx.wait();
      
      const success = receipt.status === 1;
      
      logger.transaction(tx.hash, senderWallet.address, amount, {
        receiver: receiverAddress,
        currency: 'USDC',
        success,
        gasUsed: receipt.gasUsed.toString(),
        gasPrice: receipt.gasPrice?.toString()
      });

      if (!success) {
        logger.error('Transaction failed on ARC', { 
          transactionHash: tx.hash,
          receipt
        });
        throw new ARCError(`Transaction failed: ${receipt.status}`);
      }

      const successResult = {
        success: true,
        hash: tx.hash,
        gasUsed: receipt.gasUsed.toString(),
        gasPrice: receipt.gasPrice?.toString(),
        receipt
      };
      
      // Store memo if provided
      if (memo) {
        this.transactionMemos.set(successResult.hash, memo);
        logger.info('Transaction memo stored', { hash: successResult.hash, memo });
      }

      logger.info('USDC payment completed successfully', { 
        hash: successResult.hash, 
        gasUsed: successResult.gasUsed 
      });

      return successResult;
    } catch (error) {
      logger.error('Exception in sendUSDCPayment', {
        errorType: error.constructor.name,
        errorMessage: error.message,
        stack: error.stack,
        receiverAddress,
        amount
      });
      
      if (error instanceof InsufficientFundsError || error instanceof ARCError) {
        throw error;
      }
      
      logger.error('Payment failed with unexpected error', {
        senderAddress: new ethers.Wallet(senderPrivateKey).address,
        receiverAddress,
        amount,
        error: error.message
      });
      throw new ARCError(`Payment failed: ${error.message}`);
    }
  }

  async getTransactionHistory(address, limit = 10) {
    try {
      if (!this.isConnected) {
        throw new ARCError('Not connected to ARC network');
      }

      // Get latest block number
      const latestBlock = await this.provider.getBlockNumber();
      const fromBlock = Math.max(0, latestBlock - 9999); // Look back 10k blocks

      // Get USDC contract events for transfers involving this address
      const usdcContract = new ethers.Contract(
        this.USDC_CONTRACT_ADDRESS,
        [
          'event Transfer(address indexed from, address indexed to, uint256 value)'
        ],
        this.provider
      );

      const [sentTransfers, receivedTransfers] = await Promise.all([
        usdcContract.queryFilter(
          usdcContract.filters.Transfer(address, null),
          fromBlock,
          'latest'
        ),
        usdcContract.queryFilter(
          usdcContract.filters.Transfer(null, address),
          fromBlock,
          'latest'
        )
      ]);

      const allTransfers = [...sentTransfers, ...receivedTransfers]
        .sort((a, b) => b.blockNumber - a.blockNumber)
        .slice(0, limit);

      const transactions = await Promise.all(
        allTransfers.map(async (event) => {
          const block = await this.provider.getBlock(event.blockNumber);
          const memo = this.getTransactionMemo(event.transactionHash);
          return {
            hash: event.transactionHash,
            type: 'Transfer',
            from: event.args.from,
            to: event.args.to,
            amount: ethers.formatUnits(event.args.value, 6),
            currency: 'USDC',
            blockNumber: event.blockNumber,
            date: new Date(block.timestamp * 1000).toISOString(),
            confirmed: true,
            memo: memo
          };
        })
      );

      return transactions;
    } catch (error) {
      logger.error('Failed to get transaction history', {
        address,
        error: error.message
      });
      throw new ARCError(`Failed to get transaction history: ${error.message}`);
    }
  }

  async validateAddress(address) {
    try {
      return ethers.isAddress(address);
    } catch (error) {
      return false;
    }
  }

  async getNetworkInfo() {
    try {
      if (!this.isConnected) {
        throw new ARCError('Not connected to ARC network');
      }

      const network = await this.provider.getNetwork();
      const block = await this.provider.getBlock('latest');
      const feeData = await this.provider.getFeeData();

      return {
        name: network.name,
        chainId: Number(network.chainId),
        rpcUrl: config.arc.rpcUrl,
        explorerUrl: config.arc.explorerUrl,
        latestBlock: block.number,
        gasPrice: feeData.gasPrice?.toString(),
        connected: this.isConnected
      };
    } catch (error) {
      logger.error('Failed to get network info', {
        error: error.message
      });
      throw new ARCError(`Failed to get network info: ${error.message}`);
    }
  }

  async healthCheck() {
    try {
      if (!this.isConnected) {
        return { status: 'unhealthy', service: 'ARC', error: 'Not connected' };
      }

      await this.getNetworkInfo();
      return { status: 'healthy', service: 'ARC' };
    } catch (error) {
      return { status: 'unhealthy', service: 'ARC', error: error.message };
    }
  }

  // Utility method to convert USDC amounts
  formatUSDC(amount) {
    return ethers.formatUnits(amount, 6);
  }

  parseUSDC(amount) {
    return ethers.parseUnits(amount.toString(), 6);
  }

  // Get memo for a transaction hash
  getTransactionMemo(txHash) {
    return this.transactionMemos.get(txHash) || null;
  }
}

module.exports = new ARCService();