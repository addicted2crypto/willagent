# AVAX On-Chain Intelligence Methods

This document tracks proven methods for on-chain analysis on Avalanche C-Chain.
Update as we discover what works.

---

## Data Sources

### Priority 1: Public RPC (Free)
```
Mainnet: https://api.avax.network/ext/bc/C/rpc
```
- No API key needed
- Generous rate limits
- Real-time data

### Priority 2: Aggregators
- **DexScreener**: Trending tokens, price charts
- **DeBank**: Wallet profiles, sometimes has social links
- **Snowtrace**: Block explorer, contract verification

### Priority 3: Paid APIs (Last Resort)
- Alchemy: Enhanced RPC
- Snowtrace API: Indexed historical data

---

## RPC Methods

### Get Native AVAX Balance
```typescript
eth_getBalance(address, 'latest')
// Returns: hex string in wei
// Example: "0x1bc16d674ec80000" = 2 AVAX
```

### Get ERC20 Token Balance
```typescript
eth_call({
  to: tokenContract,
  data: '0x70a08231' + paddedAddress  // balanceOf(address)
}, 'latest')
// Returns: hex balance
```

### Get Transfer Events
```typescript
eth_getLogs({
  fromBlock: '0x...',
  toBlock: 'latest',
  topics: [
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',  // Transfer
    null,           // from (any)
    paddedAddress   // to (our wallet)
  ]
})
```

### Get Token Info
```typescript
// name()
eth_call({ to: token, data: '0x06fdde03' })
// symbol()
eth_call({ to: token, data: '0x95d89b41' })
// decimals()
eth_call({ to: token, data: '0x313ce567' })
```

---

## Well-Known Tokens

| Symbol | Contract | Notes |
|--------|----------|-------|
| WAVAX | 0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7 | Wrapped AVAX |
| USDC | 0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E | Circle USDC |
| USDT | 0x9702230A8Ea53601f5cD2dc00fDbC13d4dF4A8c7 | Tether |
| JOE | 0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd | TraderJoe token |

---

## Known Wallets

Add discovered wallets here as we find them.

| Tag | Address | Twitter | Type | Notes |
|-----|---------|---------|------|-------|
| Binance | 0x9f8c163cba728e99993abe7495f06c0a3c8ac8b9 | - | exchange | Hot wallet |
| TraderJoe | 0xe0e4d6ec96f11fc1cdde1e7a3146a16ed8d5c8c8 | @tradaborjoe | protocol | Router |

---

## Wallet Profiling Strategy

### Scoring Criteria (0-100)

**Smart Money Score**
- Early calls (bought before pump): +10 per call, max 50
- Unique tokens traded: +2 per token, max 30
- Known smart money identity: +20

**Activity Score**
- >500 tx: 100
- >100 tx: 80
- >50 tx: 60
- >20 tx: 40

**Influence Score**
- Influencer: 90
- Smart money: 80
- Whale: 70
- Protocol: 50
- Unknown: 20

### Tags

| Tag | Criteria |
|-----|----------|
| early_buyer | Smart money score >= 60 |
| whale | Balance > $100k |
| active | Activity score >= 80 |
| diamond_hands | Avg hold time > 30 days |
| flipper | Avg hold time < 1 day |
| verified | Has known identity |
| new_wallet | < 10 transactions |

---

## Threshold Strategy

| Token Age | Min USD | Rationale |
|-----------|---------|-----------|
| < 6 months | $100 | Catch early moves on new tokens |
| >= 6 months | $500 | Filter noise on established tokens |

---

## Future Enhancements

- [ ] DexScreener API integration for trending tokens
- [ ] Contract age checking (deployment block)
- [ ] Price oracle (CoinGecko)
- [ ] Twitter/X account linking
- [ ] Win rate calculation (requires price history)
- [ ] Alert system for tracked wallet moves

---

## Lessons Learned

Document what works and what doesn't as we iterate.

### What Works
- Public RPC for real-time data
- eth_getLogs for transfer tracking
- Caching token info (doesn't change)

### What Doesn't Work
- (Add as we learn)

### Gotchas
- RPC returns hex strings - need to parse
- Token decimals vary (6 for USDC, 18 for most)
- Wrapped tokens (WAVAX) vs native AVAX
