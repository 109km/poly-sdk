/**
 * ArbitrageService - Real-time Arbitrage Detection and Execution
 *
 * Uses WebSocket for real-time orderbook monitoring and automatically
 * detects arbitrage opportunities in Polymarket binary markets.
 *
 * Strategy:
 * - Long Arb: Buy YES + NO (effective cost < $1) → Merge → $1 USDC
 * - Short Arb: Sell pre-held YES + NO tokens (effective revenue > $1)
 *
 * Features:
 * - Real-time orderbook monitoring via WebSocket
 * - Automatic arbitrage detection using effective prices
 * - Configurable profit threshold and trade sizes
 * - Auto-execute mode or event-based manual mode
 * - Balance tracking and position management
 *
 * Based on: scripts/arb/faze-bo3-arb.ts
 * Docs: docs/arbitrage.md
 */

import { EventEmitter } from 'events';
import { WebSocketManager } from '../clients/websocket-manager.js';
import { CTFClient, type TokenIds } from '../clients/ctf-client.js';
import { TradingClient } from '../clients/trading-client.js';
import { RateLimiter } from '../core/rate-limiter.js';
import { getEffectivePrices } from '../utils/price-utils.js';
import type { BookUpdate } from '../core/types.js';

// ===== Types =====

export interface ArbitrageMarketConfig {
  /** Market name for logging */
  name: string;
  /** Condition ID */
  conditionId: string;
  /** YES token ID from CLOB API */
  yesTokenId: string;
  /** NO token ID from CLOB API */
  noTokenId: string;
  /** Outcome names [YES, NO] */
  outcomes?: [string, string];
}

export interface ArbitrageServiceConfig {
  /** Private key for trading (optional for monitor-only mode) */
  privateKey?: string;
  /** RPC URL for CTF operations */
  rpcUrl?: string;
  /** Minimum profit threshold (default: 0.005 = 0.5%) */
  profitThreshold?: number;
  /** Minimum trade size in USDC (default: 5) */
  minTradeSize?: number;
  /** Maximum single trade size in USDC (default: 100) */
  maxTradeSize?: number;
  /** Minimum token reserve for short arb (default: 10) */
  minTokenReserve?: number;
  /** Auto-execute mode (default: false) */
  autoExecute?: boolean;
  /** Enable logging (default: true) */
  enableLogging?: boolean;
  /** Cooldown between executions in ms (default: 5000) */
  executionCooldown?: number;
}

export interface OrderbookState {
  yesBids: Array<{ price: number; size: number }>;
  yesAsks: Array<{ price: number; size: number }>;
  noBids: Array<{ price: number; size: number }>;
  noAsks: Array<{ price: number; size: number }>;
  lastUpdate: number;
}

export interface BalanceState {
  usdc: number;
  yesTokens: number;
  noTokens: number;
  lastUpdate: number;
}

export interface ArbitrageOpportunity {
  type: 'long' | 'short';
  /** Profit rate (0.01 = 1%) */
  profitRate: number;
  /** Profit in percentage */
  profitPercent: number;
  /** Effective buy/sell prices */
  effectivePrices: {
    buyYes: number;
    buyNo: number;
    sellYes: number;
    sellNo: number;
  };
  /** Maximum executable size based on orderbook depth */
  maxOrderbookSize: number;
  /** Maximum executable size based on balance */
  maxBalanceSize: number;
  /** Recommended trade size */
  recommendedSize: number;
  /** Estimated profit in USDC */
  estimatedProfit: number;
  /** Description */
  description: string;
  /** Timestamp */
  timestamp: number;
}

export interface ArbitrageExecutionResult {
  success: boolean;
  type: 'long' | 'short';
  size: number;
  profit: number;
  txHashes: string[];
  error?: string;
  executionTimeMs: number;
}

export interface ArbitrageServiceEvents {
  opportunity: (opportunity: ArbitrageOpportunity) => void;
  execution: (result: ArbitrageExecutionResult) => void;
  balanceUpdate: (balance: BalanceState) => void;
  orderbookUpdate: (orderbook: OrderbookState) => void;
  error: (error: Error) => void;
  started: (market: ArbitrageMarketConfig) => void;
  stopped: () => void;
}

// ===== ArbitrageService =====

export class ArbitrageService extends EventEmitter {
  private wsManager: WebSocketManager;
  private ctf: CTFClient | null = null;
  private tradingClient: TradingClient | null = null;
  private rateLimiter: RateLimiter;

  private market: ArbitrageMarketConfig | null = null;
  private config: Required<Omit<ArbitrageServiceConfig, 'privateKey' | 'rpcUrl'>> & {
    privateKey?: string;
    rpcUrl?: string;
  };

  private orderbook: OrderbookState = {
    yesBids: [],
    yesAsks: [],
    noBids: [],
    noAsks: [],
    lastUpdate: 0,
  };

  private balance: BalanceState = {
    usdc: 0,
    yesTokens: 0,
    noTokens: 0,
    lastUpdate: 0,
  };

  private isExecuting = false;
  private lastExecutionTime = 0;
  private balanceUpdateInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  // Statistics
  private stats = {
    opportunitiesDetected: 0,
    executionsAttempted: 0,
    executionsSucceeded: 0,
    totalProfit: 0,
    startTime: 0,
  };

  constructor(config: ArbitrageServiceConfig = {}) {
    super();

    this.config = {
      privateKey: config.privateKey,
      rpcUrl: config.rpcUrl || 'https://polygon-rpc.com',
      profitThreshold: config.profitThreshold ?? 0.005,
      minTradeSize: config.minTradeSize ?? 5,
      maxTradeSize: config.maxTradeSize ?? 100,
      minTokenReserve: config.minTokenReserve ?? 10,
      autoExecute: config.autoExecute ?? false,
      enableLogging: config.enableLogging ?? true,
      executionCooldown: config.executionCooldown ?? 5000,
    };

    this.rateLimiter = new RateLimiter();
    this.wsManager = new WebSocketManager({ enableLogging: false });

    // Initialize trading clients if private key provided
    if (this.config.privateKey) {
      this.ctf = new CTFClient({
        privateKey: this.config.privateKey,
        rpcUrl: this.config.rpcUrl,
      });

      this.tradingClient = new TradingClient(this.rateLimiter, {
        privateKey: this.config.privateKey,
        chainId: 137,
      });
    }

    // Set up WebSocket event handlers
    this.wsManager.on('bookUpdate', this.handleBookUpdate.bind(this));
    this.wsManager.on('error', (error) => this.emit('error', error));
  }

  // ===== Public API =====

  /**
   * Start monitoring a market for arbitrage opportunities
   */
  async start(market: ArbitrageMarketConfig): Promise<void> {
    if (this.isRunning) {
      throw new Error('ArbitrageService is already running. Call stop() first.');
    }

    this.market = market;
    this.isRunning = true;
    this.stats.startTime = Date.now();

    this.log(`Starting arbitrage monitor for: ${market.name}`);
    this.log(`Condition ID: ${market.conditionId.slice(0, 20)}...`);
    this.log(`Profit Threshold: ${(this.config.profitThreshold * 100).toFixed(2)}%`);
    this.log(`Auto Execute: ${this.config.autoExecute ? 'YES' : 'NO'}`);

    // Initialize trading client
    if (this.tradingClient) {
      await this.tradingClient.initialize();
      this.log(`Wallet: ${this.ctf?.getAddress()}`);
      await this.updateBalance();
      this.log(`USDC Balance: ${this.balance.usdc.toFixed(2)}`);
      this.log(`YES Tokens: ${this.balance.yesTokens.toFixed(2)}`);
      this.log(`NO Tokens: ${this.balance.noTokens.toFixed(2)}`);

      // Start balance update interval
      this.balanceUpdateInterval = setInterval(() => this.updateBalance(), 30000);
    } else {
      this.log('No wallet configured - monitoring only');
    }

    // Subscribe to WebSocket
    await this.wsManager.subscribe([market.yesTokenId, market.noTokenId]);

    this.emit('started', market);
    this.log('Monitoring for arbitrage opportunities...');
  }

  /**
   * Stop monitoring
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.balanceUpdateInterval) {
      clearInterval(this.balanceUpdateInterval);
      this.balanceUpdateInterval = null;
    }

    await this.wsManager.unsubscribeAll();

    this.log('Stopped');
    this.log(`Total opportunities: ${this.stats.opportunitiesDetected}`);
    this.log(`Executions: ${this.stats.executionsSucceeded}/${this.stats.executionsAttempted}`);
    this.log(`Total profit: $${this.stats.totalProfit.toFixed(2)}`);

    this.emit('stopped');
  }

  /**
   * Get current orderbook state
   */
  getOrderbook(): OrderbookState {
    return { ...this.orderbook };
  }

  /**
   * Get current balance state
   */
  getBalance(): BalanceState {
    return { ...this.balance };
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      runningTimeMs: this.isRunning ? Date.now() - this.stats.startTime : 0,
    };
  }

  /**
   * Check for arbitrage opportunity based on current orderbook
   */
  checkOpportunity(): ArbitrageOpportunity | null {
    if (!this.market) return null;

    const { yesBids, yesAsks, noBids, noAsks } = this.orderbook;
    if (yesBids.length === 0 || yesAsks.length === 0 || noBids.length === 0 || noAsks.length === 0) {
      return null;
    }

    const yesBestBid = yesBids[0]?.price || 0;
    const yesBestAsk = yesAsks[0]?.price || 1;
    const noBestBid = noBids[0]?.price || 0;
    const noBestAsk = noAsks[0]?.price || 1;

    // Calculate effective prices
    const effective = getEffectivePrices(yesBestAsk, yesBestBid, noBestAsk, noBestBid);

    // Check for arbitrage
    const longCost = effective.effectiveBuyYes + effective.effectiveBuyNo;
    const longProfit = 1 - longCost;
    const shortRevenue = effective.effectiveSellYes + effective.effectiveSellNo;
    const shortProfit = shortRevenue - 1;

    // Calculate sizes
    const orderbookLongSize = Math.min(yesAsks[0]?.size || 0, noAsks[0]?.size || 0);
    const orderbookShortSize = Math.min(yesBids[0]?.size || 0, noBids[0]?.size || 0);
    const heldPairs = Math.min(this.balance.yesTokens, this.balance.noTokens);
    const balanceLongSize = longCost > 0 ? this.balance.usdc / longCost : 0;

    // Check long arb
    if (longProfit > this.config.profitThreshold) {
      const maxSize = Math.min(orderbookLongSize, balanceLongSize, this.config.maxTradeSize);
      if (maxSize >= this.config.minTradeSize) {
        return {
          type: 'long',
          profitRate: longProfit,
          profitPercent: longProfit * 100,
          effectivePrices: {
            buyYes: effective.effectiveBuyYes,
            buyNo: effective.effectiveBuyNo,
            sellYes: effective.effectiveSellYes,
            sellNo: effective.effectiveSellNo,
          },
          maxOrderbookSize: orderbookLongSize,
          maxBalanceSize: balanceLongSize,
          recommendedSize: maxSize,
          estimatedProfit: longProfit * maxSize,
          description: `Buy YES @ ${effective.effectiveBuyYes.toFixed(4)} + NO @ ${effective.effectiveBuyNo.toFixed(4)}, Merge for $1`,
          timestamp: Date.now(),
        };
      }
    }

    // Check short arb
    if (shortProfit > this.config.profitThreshold) {
      const maxSize = Math.min(orderbookShortSize, heldPairs, this.config.maxTradeSize);
      if (maxSize >= this.config.minTradeSize && heldPairs >= this.config.minTokenReserve) {
        return {
          type: 'short',
          profitRate: shortProfit,
          profitPercent: shortProfit * 100,
          effectivePrices: {
            buyYes: effective.effectiveBuyYes,
            buyNo: effective.effectiveBuyNo,
            sellYes: effective.effectiveSellYes,
            sellNo: effective.effectiveSellNo,
          },
          maxOrderbookSize: orderbookShortSize,
          maxBalanceSize: heldPairs,
          recommendedSize: maxSize,
          estimatedProfit: shortProfit * maxSize,
          description: `Sell YES @ ${effective.effectiveSellYes.toFixed(4)} + NO @ ${effective.effectiveSellNo.toFixed(4)}`,
          timestamp: Date.now(),
        };
      }
    }

    return null;
  }

  /**
   * Manually execute an arbitrage opportunity
   */
  async execute(opportunity: ArbitrageOpportunity): Promise<ArbitrageExecutionResult> {
    if (!this.ctf || !this.tradingClient || !this.market) {
      return {
        success: false,
        type: opportunity.type,
        size: 0,
        profit: 0,
        txHashes: [],
        error: 'Trading not configured (no private key)',
        executionTimeMs: 0,
      };
    }

    if (this.isExecuting) {
      return {
        success: false,
        type: opportunity.type,
        size: 0,
        profit: 0,
        txHashes: [],
        error: 'Another execution in progress',
        executionTimeMs: 0,
      };
    }

    this.isExecuting = true;
    this.stats.executionsAttempted++;
    const startTime = Date.now();

    try {
      const result = opportunity.type === 'long'
        ? await this.executeLongArb(opportunity)
        : await this.executeShortArb(opportunity);

      if (result.success) {
        this.stats.executionsSucceeded++;
        this.stats.totalProfit += result.profit;
        this.lastExecutionTime = Date.now();
      }

      this.emit('execution', result);
      return result;
    } finally {
      this.isExecuting = false;
      // Update balance after execution
      await this.updateBalance();
    }
  }

  // ===== Private Methods =====

  private handleBookUpdate(update: BookUpdate): void {
    if (!this.market) return;

    const { assetId, bids, asks } = update;

    type PriceLevel = { price: number; size: number };
    if (assetId === this.market.yesTokenId) {
      this.orderbook.yesBids = bids.sort((a: PriceLevel, b: PriceLevel) => b.price - a.price);
      this.orderbook.yesAsks = asks.sort((a: PriceLevel, b: PriceLevel) => a.price - b.price);
    } else if (assetId === this.market.noTokenId) {
      this.orderbook.noBids = bids.sort((a: PriceLevel, b: PriceLevel) => b.price - a.price);
      this.orderbook.noAsks = asks.sort((a: PriceLevel, b: PriceLevel) => a.price - b.price);
    }

    this.orderbook.lastUpdate = Date.now();
    this.emit('orderbookUpdate', this.orderbook);

    // Check for arbitrage opportunity
    this.checkAndHandleOpportunity();
  }

  private checkAndHandleOpportunity(): void {
    const opportunity = this.checkOpportunity();

    if (opportunity) {
      this.stats.opportunitiesDetected++;
      this.emit('opportunity', opportunity);

      this.log(`\n${'!'.repeat(60)}`);
      this.log(`${opportunity.type.toUpperCase()} ARB: ${opportunity.description}`);
      this.log(`Profit: ${opportunity.profitPercent.toFixed(2)}%, Size: ${opportunity.recommendedSize.toFixed(2)}, Est: $${opportunity.estimatedProfit.toFixed(2)}`);
      this.log('!'.repeat(60));

      // Auto-execute if enabled and cooldown has passed
      if (this.config.autoExecute && !this.isExecuting) {
        const timeSinceLastExecution = Date.now() - this.lastExecutionTime;
        if (timeSinceLastExecution >= this.config.executionCooldown) {
          this.execute(opportunity).catch((error) => {
            this.emit('error', error);
          });
        }
      }
    }
  }

  private async updateBalance(): Promise<void> {
    if (!this.ctf || !this.market) return;

    try {
      const tokenIds: TokenIds = {
        yesTokenId: this.market.yesTokenId,
        noTokenId: this.market.noTokenId,
      };

      const [usdcBalance, positions] = await Promise.all([
        this.ctf.getUsdcBalance(),
        this.ctf.getPositionBalanceByTokenIds(this.market.conditionId, tokenIds),
      ]);

      this.balance = {
        usdc: parseFloat(usdcBalance),
        yesTokens: parseFloat(positions.yesBalance),
        noTokens: parseFloat(positions.noBalance),
        lastUpdate: Date.now(),
      };

      this.emit('balanceUpdate', this.balance);
    } catch (error) {
      this.emit('error', error as Error);
    }
  }

  private async executeLongArb(opportunity: ArbitrageOpportunity): Promise<ArbitrageExecutionResult> {
    const startTime = Date.now();
    const txHashes: string[] = [];
    const size = opportunity.recommendedSize;

    this.log(`\nExecuting Long Arb (Buy → Merge)...`);

    try {
      const { buyYes, buyNo } = opportunity.effectivePrices;
      const requiredUsdc = (buyYes + buyNo) * size;

      if (this.balance.usdc < requiredUsdc) {
        return {
          success: false,
          type: 'long',
          size,
          profit: 0,
          txHashes,
          error: `Insufficient USDC.e: have ${this.balance.usdc.toFixed(2)}, need ${requiredUsdc.toFixed(2)}`,
          executionTimeMs: Date.now() - startTime,
        };
      }

      // Buy both tokens in parallel
      this.log(`  1. Buying tokens in parallel...`);
      const [buyYesResult, buyNoResult] = await Promise.all([
        this.tradingClient!.createMarketOrder({
          tokenId: this.market!.yesTokenId,
          side: 'BUY',
          amount: size * buyYes,
          orderType: 'FOK',
        }),
        this.tradingClient!.createMarketOrder({
          tokenId: this.market!.noTokenId,
          side: 'BUY',
          amount: size * buyNo,
          orderType: 'FOK',
        }),
      ]);

      const outcomes = this.market!.outcomes || ['YES', 'NO'];
      this.log(`     ${outcomes[0]}: ${buyYesResult.success ? '✓' : '✗'}, ${outcomes[1]}: ${buyNoResult.success ? '✓' : '✗'}`);

      if (!buyYesResult.success || !buyNoResult.success) {
        return {
          success: false,
          type: 'long',
          size,
          profit: 0,
          txHashes,
          error: `Order(s) failed: YES=${buyYesResult.errorMsg}, NO=${buyNoResult.errorMsg}`,
          executionTimeMs: Date.now() - startTime,
        };
      }

      // Merge tokens
      const tokenIds: TokenIds = {
        yesTokenId: this.market!.yesTokenId,
        noTokenId: this.market!.noTokenId,
      };

      // Update balance to get accurate token counts
      await this.updateBalance();
      const heldPairs = Math.min(this.balance.yesTokens, this.balance.noTokens);
      const mergeSize = Math.floor(Math.min(size, heldPairs) * 1e6) / 1e6;

      if (mergeSize >= this.config.minTradeSize) {
        this.log(`  2. Merging ${mergeSize.toFixed(2)} pairs...`);
        try {
          const mergeResult = await this.ctf!.mergeByTokenIds(
            this.market!.conditionId,
            tokenIds,
            mergeSize.toString()
          );
          txHashes.push(mergeResult.txHash);
          this.log(`     TX: ${mergeResult.txHash}`);

          const profit = opportunity.profitRate * mergeSize;
          this.log(`  ✅ Long Arb completed! Profit: ~$${profit.toFixed(2)}`);

          return {
            success: true,
            type: 'long',
            size: mergeSize,
            profit,
            txHashes,
            executionTimeMs: Date.now() - startTime,
          };
        } catch (mergeError: any) {
          this.log(`  ⚠️ Merge failed: ${mergeError.message}`);
          return {
            success: false,
            type: 'long',
            size,
            profit: 0,
            txHashes,
            error: `Merge failed: ${mergeError.message}`,
            executionTimeMs: Date.now() - startTime,
          };
        }
      }

      return {
        success: false,
        type: 'long',
        size,
        profit: 0,
        txHashes,
        error: `Insufficient pairs for merge: ${heldPairs.toFixed(2)}`,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (error: any) {
      return {
        success: false,
        type: 'long',
        size,
        profit: 0,
        txHashes,
        error: error.message,
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  private async executeShortArb(opportunity: ArbitrageOpportunity): Promise<ArbitrageExecutionResult> {
    const startTime = Date.now();
    const txHashes: string[] = [];
    const size = opportunity.recommendedSize;

    this.log(`\nExecuting Short Arb (Sell Pre-held Tokens)...`);

    try {
      const heldPairs = Math.min(this.balance.yesTokens, this.balance.noTokens);

      if (heldPairs < size) {
        return {
          success: false,
          type: 'short',
          size,
          profit: 0,
          txHashes,
          error: `Insufficient held tokens: have ${heldPairs.toFixed(2)}, need ${size.toFixed(2)}`,
          executionTimeMs: Date.now() - startTime,
        };
      }

      // Sell both tokens in parallel
      this.log(`  1. Selling pre-held tokens in parallel...`);
      const [sellYesResult, sellNoResult] = await Promise.all([
        this.tradingClient!.createMarketOrder({
          tokenId: this.market!.yesTokenId,
          side: 'SELL',
          amount: size,
          orderType: 'FOK',
        }),
        this.tradingClient!.createMarketOrder({
          tokenId: this.market!.noTokenId,
          side: 'SELL',
          amount: size,
          orderType: 'FOK',
        }),
      ]);

      const outcomes = this.market!.outcomes || ['YES', 'NO'];
      this.log(`     ${outcomes[0]}: ${sellYesResult.success ? '✓' : '✗'}, ${outcomes[1]}: ${sellNoResult.success ? '✓' : '✗'}`);

      if (!sellYesResult.success || !sellNoResult.success) {
        return {
          success: false,
          type: 'short',
          size,
          profit: 0,
          txHashes,
          error: `Order(s) failed: YES=${sellYesResult.errorMsg}, NO=${sellNoResult.errorMsg}`,
          executionTimeMs: Date.now() - startTime,
        };
      }

      const profit = opportunity.profitRate * size;
      this.log(`  ✅ Short Arb completed! Profit: ~$${profit.toFixed(2)}`);

      return {
        success: true,
        type: 'short',
        size,
        profit,
        txHashes,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (error: any) {
      return {
        success: false,
        type: 'short',
        size,
        profit: 0,
        txHashes,
        error: error.message,
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  private log(message: string): void {
    if (this.config.enableLogging) {
      console.log(`[ArbitrageService] ${message}`);
    }
  }
}
