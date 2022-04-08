import "regenerator-runtime/runtime"

import * as nearAPI from "near-api-js"
import { baseDecode } from "borsh"
import { getConfig } from "./nearConfig"
import { SwapAction } from "./ref-finance"

declare global {
    interface Window {
        redirectTo: number
        NEAR_ENV: string
        account: nearAPI.ConnectedWalletAccount
        near: nearAPI.Near
        walletAccount: nearAPI.WalletConnection
        contract_metapool: nearAPI.Contract
        contract_wnear: nearAPI.Contract
        contract_ref_exchange: nearAPI.Contract
        contract_ref_farming: nearAPI.Contract
        nearConfig: any
        nearInitPromise: any
    }
}

window.nearConfig = getConfig("mainnet")

export default class BaseLogic {
    SIMPLE_POOL_SHARE_DECIMALS = 24
    FARM_STORAGE_BALANCE: string = nearAPI.utils.format.parseNearAmount("0.045") as string
    MIN_DEPOSIT_PER_TOKEN: string = nearAPI.utils.format.parseNearAmount("0.005") as string
    ONE_MORE_DEPOSIT_AMOUNT: string = nearAPI.utils.format.parseNearAmount("0.01") as string
    LP_STORAGE_AMOUNT: string = nearAPI.utils.format.parseNearAmount("0.01") as string
    NEW_ACCOUNT_STORAGE_COST: string = nearAPI.utils.format.parseNearAmount("0.00125") as string

    // Initializing contract
    // TEMP generalized
    static async initNear() {
        // Initializing connection to the NEAR node.
        window.near = await nearAPI.connect(
            Object.assign(
                {
                    deps: {
                        keyStore: new nearAPI.keyStores.BrowserLocalStorageKeyStore()
                    }
                },
                window.nearConfig
            )
        )

        // Initializing Wallet based Account.
        window.walletAccount = new nearAPI.WalletAccount(window.near, null)
        window.account = window.walletAccount.account()
    }

    /**
     * get pool LP shares that the user staked on Ref farming
     *
     * @param pool_id
     * @returns
     */
    async getFarmingStake(pool_id: number): Promise<string> {
        const seeds: any = await window.account.viewFunction(window.nearConfig.ADDRESS_REF_FARMING, "list_user_seeds", {
            account_id: window.account.accountId
        })
        return seeds[`${window.nearConfig.ADDRESS_REF_EXCHANGE}@${pool_id}`]
            ? seeds[`${window.nearConfig.ADDRESS_REF_EXCHANGE}@${pool_id}`]
            : "0"
    }

    /**
     * stake ref-finance LP shares in ref-finance farm
     *
     * @param amount LP shares to stake
     * @param poolID liquidity pool whose shares will be staked
     * @returns
     */
    async farmStake(amount: string, poolID: number): Promise<nearAPI.transactions.Transaction[]> {
        const preTXs: Promise<nearAPI.transactions.Transaction>[] = []
        const storageActions: nearAPI.transactions.Action[] = []
        const stakingActions: nearAPI.transactions.Action[] = []

        const storage_balance: any = await window.account.viewFunction(
            window.nearConfig.ADDRESS_REF_FARMING,
            "storage_balance_of",
            {
                account_id: window.account.accountId
            }
        )

        if (
            !storage_balance ||
            BigInt(storage_balance?.available ?? "0") < BigInt(this.FARM_STORAGE_BALANCE) ||
            BigInt(storage_balance?.available ?? "0") < BigInt(this.MIN_DEPOSIT_PER_TOKEN)
        ) {
            storageActions.push(
                nearAPI.transactions.functionCall(
                    "storage_deposit", // contract method to deposit NEAR for wNEAR
                    {},
                    20_000_000_000_000, // attached gas
                    this.FARM_STORAGE_BALANCE // amount of NEAR to deposit and wrap
                )
            )
        }

        stakingActions.push(
            nearAPI.transactions.functionCall(
                "mft_transfer_call",
                {
                    receiver_id: window.nearConfig.ADDRESS_REF_FARMING,
                    token_id: `:${poolID}`,
                    amount: amount,
                    msg: ""
                },
                180_000_000_000_000,
                "1" // one yocto
            )
        )

        // only add storage transaction if needed
        if (storageActions.length > 0) {
            preTXs.push(this.makeTransaction(window.nearConfig.ADDRESS_REF_FARMING, storageActions))
        }

        preTXs.push(this.makeTransaction(window.nearConfig.ADDRESS_REF_EXCHANGE, stakingActions))

        return await Promise.all(preTXs)
    }

    /**
     * unstake shares from ref-finance farm
     *
     * @param amount
     * @param poolID
     * @returns
     */
    async farmUnstake(amount: string, poolID: number): Promise<nearAPI.transactions.Transaction[]> {
        const actions: nearAPI.transactions.Action[] = []
        // query user storage
        const storage_balance: any = await window.account.viewFunction(
            window.nearConfig.ADDRESS_REF_FARMING,
            "storage_balance_of",
            {
                account_id: window.account.accountId
            }
        )

        if (storage_balance === null || BigInt(storage_balance.available) <= BigInt("0")) {
            actions.push(
                nearAPI.transactions.functionCall(
                    "storage_deposit", // contract method to deposit NEAR for wNEAR
                    {},
                    20_000_000_000_000, // attached gas
                    this.FARM_STORAGE_BALANCE // amount of NEAR to deposit and wrap
                )
            )
        }

        actions.push(
            nearAPI.transactions.functionCall(
                "withdraw_seed",
                {
                    seed_id: `${window.nearConfig.ADDRESS_REF_EXCHANGE}@${poolID}`,
                    amount: amount,
                    msg: ""
                },
                200_000_000_000_000,
                "1" // one yocto
            )
        )

        const TX: nearAPI.transactions.Transaction = await this.makeTransaction(
            window.nearConfig.ADDRESS_REF_FARMING,
            actions
        )

        return [TX]
    }

    /**
     * calculate minimum token amounts a user gets by removing LP from a pool
     *
     * @param user_shares LP shares owner by the user
     * @param total_shares total LP shares in the pool
     * @param amounts total token amounts in the pool
     * @returns minimum token amounts user should get
     */
    calcMinLPAmountsOut(user_shares: string, total_shares: string, amounts: string[]): string[] {
        return amounts.map(amount => {
            let exact_amount = (BigInt(amount) * BigInt(user_shares)) / BigInt(total_shares)
            // add 0.1% slippage tolerance
            return ((exact_amount * BigInt("999")) / BigInt("1000")).toString()
        })
    }

    /**
     * Get pool info of a ref-finance pool
     *
     * IMPORTANT: after calling this function disable the associated button.
     * REASON: consider following scenario:
     * 1- UI makes request to refresh min_amount_out
     * 2- before response arrives, user clicks button and thinks old values will apply
     * 3- new values arrive
     * 4- wallet re-direct arrives
     * => user will approve new values thinking they will get the old values
     *
     * @param {number} poolID ref-finance pool ID
     * @returns { Object } pool infos:
     *          the pool fee
     *          the amount of LP shares the user holds,
     *          the total amount of LP shares there are and
     *          the token amounts, that are in the pool
     */
    async getPoolInfo(poolID: number): Promise<{
        fee: number
        user_shares: string
        total_shares: string
        pool_amounts: string[]
    }> {
        // get user shares
        const user_shares: string = await window.account.viewFunction(
            window.nearConfig.ADDRESS_REF_EXCHANGE,
            "get_pool_shares",
            {
                pool_id: poolID,
                account_id: window.account.accountId
            }
        )

        // get pool info
        const {
            total_fee,
            amounts,
            shares_total_supply: total_shares
        }: {
            total_fee: number
            amounts: string[]
            shares_total_supply: string
        } = await window.account.viewFunction(window.nearConfig.ADDRESS_REF_EXCHANGE, "get_pool", {
            pool_id: poolID
        })

        return { fee: total_fee, user_shares, total_shares, pool_amounts: amounts }
    }

    /**
     * Given specific pool, returns amount of token_out recevied swapping amount_in of token_in.
     *
     * @param params
     */
    async getPoolReturn(params: {
        pool_id: number
        token_in: string
        amount_in: string
        token_out: string
    }): Promise<string> {
        const amount: string = await window.account.viewFunction(
            window.nearConfig.ADDRESS_REF_EXCHANGE,
            "get_return",
            params
        )

        return amount
    }

    /**
     * add liquity to a pool on ref-finance
     *
     * @param positions
     * @returns
     */
    async addLiquidity(
        positions: {
            pool_id: number
            amounts: string[]
        }[]
    ): Promise<nearAPI.transactions.Transaction[]> {
        const preTXs: Promise<nearAPI.transactions.Transaction>[] = []
        const refActions: nearAPI.transactions.Action[] = []

        // add LP positions
        for (let i = 0; i < positions.length; i++) {
            // current position info
            const { pool_id, amounts } = positions[i]

            // set slippage protection to 0.1%
            const min_lp_amounts: string[] = amounts.map(amount =>
                ((BigInt(amount) * BigInt("999")) / BigInt("1000")).toString()
            )

            // add liquidity to pool
            // no need to check for storage as storage deposit
            // is take from attached deposit for this action
            refActions.push(
                nearAPI.transactions.functionCall(
                    "add_liquidity",
                    {
                        pool_id: pool_id,
                        amounts: amounts,
                        min_amounts: min_lp_amounts
                    },
                    100_000_000_000_000,
                    this.LP_STORAGE_AMOUNT
                )
            )
        }

        preTXs.push(this.makeTransaction(window.nearConfig.ADDRESS_REF_EXCHANGE, refActions))
        const TXs: nearAPI.transactions.Transaction[] = await Promise.all(preTXs)

        return TXs
    }

    /**
     * perform one swap action on ref-finance using instant-swap
     * for info on instant-swap, see:
     * https://github.com/ref-finance/ref-contracts/blob/22099fa4476f1d6dd94573063307783902568d63/ref-exchange/src/token_receiver.rs#L63
     *
     * @param swap_action
     */
    async instantSwap(swap_action: SwapAction): Promise<nearAPI.transactions.Transaction[]> {
        const preTXs: Promise<nearAPI.transactions.Transaction>[] = []
        // use for swapping
        const tokenInActions: nearAPI.transactions.Action[] = []
        // use to pay for storage if needed
        const tokenOutActions: nearAPI.transactions.Action[] = []

        // query user storage balance on ref contract
        const tokenOutStorage: any = await window.account.viewFunction(swap_action.token_out, "storage_balance_of", {
            account_id: window.account.accountId
        })
        if (!tokenOutStorage || BigInt(tokenOutStorage.total) <= BigInt("0")) {
            tokenOutActions.push(
                nearAPI.transactions.functionCall(
                    "storage_deposit",
                    {},
                    30_000_000_000_000,
                    this.NEW_ACCOUNT_STORAGE_COST
                )
            )
        }

        // swap
        tokenInActions.push(
            nearAPI.transactions.functionCall(
                "ft_transfer_call",
                {
                    receiver_id: window.nearConfig.ADDRESS_REF_EXCHANGE,
                    amount: swap_action.amount_in,
                    msg: JSON.stringify({
                        force: 0,
                        actions: [swap_action]
                    })
                },
                180_000_000_000_000,
                "1" // one yocto
            )
        )

        // only add storage transaction if needed
        if (tokenOutActions.length > 0) {
            preTXs.push(this.makeTransaction(swap_action.token_out, tokenOutActions))
        }

        preTXs.push(this.makeTransaction(swap_action.token_in, tokenInActions))

        return await Promise.all(preTXs)
    }

    // get user native NEAR balance
    async getNativeNearBalance(): Promise<string> {
        const accountBalance = await window.account.getAccountBalance()
        return accountBalance.available
    }

    // stake NEAR with metapool to get stNEAR
    async nearToStnear(near_amount: string): Promise<nearAPI.transactions.Transaction[]> {
        const preTXs: Promise<nearAPI.transactions.Transaction>[] = []
        const metapoolActions: nearAPI.transactions.Action[] = []

        // deposit NEAR to metapool
        metapoolActions.push(
            nearAPI.transactions.functionCall("deposit_and_stake", {}, 50_000_000_000_000, near_amount)
        )

        preTXs.push(this.makeTransaction(window.nearConfig.ADDRESS_METAPOOL, metapoolActions))

        const TXs = await Promise.all(preTXs)
        return TXs
    }

    async nearToWnear(near_amount: string): Promise<nearAPI.transactions.Transaction[]> {
        const preTXs: Promise<nearAPI.transactions.Transaction>[] = []
        const wNearActions: nearAPI.transactions.Action[] = []

        // query user storage balance on wNEAR contract
        const wnearStorage: any = await window.account.viewFunction(
            window.nearConfig.ADDRESS_WNEAR,
            "storage_balance_of",
            {
                account_id: window.account.accountId
            }
        )

        if (!wnearStorage || BigInt(wnearStorage.total) <= BigInt("0")) {
            wNearActions.push(
                nearAPI.transactions.functionCall(
                    "storage_deposit",
                    {},
                    30_000_000_000_000,
                    this.NEW_ACCOUNT_STORAGE_COST
                )
            )
        }

        // deposit NEAR to metapool
        wNearActions.push(nearAPI.transactions.functionCall("near_deposit", {}, 50_000_000_000_000, near_amount))

        preTXs.push(this.makeTransaction(window.nearConfig.ADDRESS_WNEAR, wNearActions))

        const TXs = await Promise.all(preTXs)
        return TXs
    }

    // get stNEAR price and min deposit amount in $NEAR
    async getMetapoolInfo(): Promise<{
        st_near_price: string
        min_deposit_amount: string
    }> {
        const contract_state: any = await window.account.viewFunction(
            window.nearConfig.ADDRESS_METAPOOL,
            "get_contract_state",
            {}
        )
        return {
            st_near_price: contract_state["st_near_price"],
            min_deposit_amount: contract_state["min_deposit_amount"]
        }
    }

    /**
     * query user balance of multiple fungible tokens
     *
     * @param tokens token addresses
     */
    async getTokenBalances(tokens: string[]): Promise<string[]> {
        const balances: string[] = await Promise.all(
            tokens.map(async token => {
                // query user balance of token
                const balance: string = await window.account.viewFunction(token, "ft_balance_of", {
                    account_id: window.account.accountId
                })
                return balance
            })
        )

        return balances
    }

    /**
     * query user's Ref deposits of multiple fungible tokens
     *
     * @param tokens token addresses
     */
    async getTokenBalancesOnRef(tokens: string[]): Promise<string[]> {
        const refBalances: any = await window.account.viewFunction(
            window.nearConfig.ADDRESS_REF_EXCHANGE,
            "get_deposits",
            { account_id: window.account.accountId }
        )
        const balances: string[] = tokens.map(token => {
            return refBalances[token] ? refBalances[token] : "0"
        })

        return balances
    }

    /**
     * deposit multiple tokens on Ref.
     * Assumptions:
     * 1- ref-finance contract already has storage deposit on provided tokens
     * 2- provided tokens are on the ref-finance global whitelist
     *
     * !! IMPORTANT !!
     * if you want to deposit multiple tokens at once, then:
     * @example good: all tokens in 1 call
     * depositTokensOnRef([{token: "dai", amount: "1"}, {token: "usdt", amount: "1"}])
     * @example bad: separate calls miscalculate required user storage on ref-finance
     * depositTokensOnRef([{token: "dai", amount: "1"}])
     * depositTokensOnRef([{token: "usdt", amount: "1"}])
     *
     *
     * @param deposits
     */
    async depositTokensOnRef(
        deposits: { token: string; amount: string }[]
    ): Promise<nearAPI.transactions.Transaction[]> {
        const preTXs: Promise<nearAPI.transactions.Transaction>[] = []
        const tokensActions: {
            address: string
            actions: nearAPI.transactions.Action[]
        }[] = []
        // increase user storage balance on ref before token deposits
        const refActions: nearAPI.transactions.Action[] = []

        const storage_needed: bigint = BigInt(deposits.length) * BigInt(this.MIN_DEPOSIT_PER_TOKEN)
        // query user storage on ref
        const storage_balance: any = await window.account.viewFunction(
            window.nearConfig.ADDRESS_REF_EXCHANGE,
            "storage_balance_of",
            {
                account_id: window.account.accountId
            }
        )

        // check if user storage is enough for depositing n tokens
        if (storage_balance === null || BigInt(storage_balance.available) <= storage_needed) {
            // calculate amount to pay
            const amountMissing: string = (storage_needed - BigInt(storage_balance.available)).toString()
            const amountToPay: string = this.roundUpToNearest(amountMissing, this.MIN_DEPOSIT_PER_TOKEN)

            refActions.push(
                nearAPI.transactions.functionCall(
                    "storage_deposit", // contract method to deposit NEAR for wNEAR
                    {},
                    20_000_000_000_000, // attached gas
                    amountToPay // NEAR attached amount
                )
            )
        }

        for (let i = 0; i < deposits.length; i++) {
            tokensActions.push({
                address: deposits[i].token,
                actions: [
                    nearAPI.transactions.functionCall(
                        "ft_transfer_call",
                        {
                            receiver_id: window.nearConfig.ADDRESS_REF_EXCHANGE,
                            amount: deposits[i].amount,
                            msg: ""
                        },
                        150_000_000_000_000,
                        "1" // one yocto
                    )
                ]
            })
        }

        // transaction object for ref-finance storage deposit (if needed)
        if (refActions.length >= 1) {
            preTXs.push(this.makeTransaction(window.nearConfig.ADDRESS_REF_EXCHANGE, refActions))
        }
        // transaction objects for deposits. Each token deposit is a separate transaction
        for (let i = 0; i < deposits.length; i++) {
            preTXs.push(this.makeTransaction(tokensActions[i].address, tokensActions[i].actions))
        }

        const TXs = await Promise.all(preTXs)
        return TXs
    }

    /**
     * estimate LP shares user should get by supplying amounts
     * see https://github.com/ref-finance/ref-contracts/blob/3c04fd20767ad7f1c383deee8e0a2b5ab47fbc18/ref-exchange/src/simple_pool.rs#L118
     *
     * @param pool_total_shares
     * @param pool_amounts total token amounts on pool
     * @param lp_amounts token amounts that user will supply
     * @returns
     */
    calcLpSharesFromAmounts(pool_total_shares: string, pool_amounts: string[], lp_amounts: string[]): string {
        let lp_shares_estimate: string = pool_amounts.reduce((prevValue, poolAmt, index) => {
            let currValue = (BigInt(pool_total_shares) * BigInt(lp_amounts[index])) / BigInt(poolAmt)
            return BigInt(prevValue) < currValue ? prevValue : currValue.toString()
        })

        // set tolerance to 0.3%
        // !!! important leave at least 1 LP share to occupy storage
        // see: https://github.com/ref-finance/ref-contracts/issues/36
        lp_shares_estimate = ((BigInt(lp_shares_estimate) * BigInt("997")) / BigInt("1000")).toString()

        return lp_shares_estimate
    }

    /**
     * round number x to next nearest multiple of m.
     * if (x % m == 0) then return x
     * else return nearest multiple of m that's bigger than x
     *
     * @example
     * roundUpToNearest (0, 5) => 0
     * roundUpToNearest (39, 5) => 40
     * roundUpToNearest (40, 5) => 40
     * roundUpToNearest (41, 5) => 45
     *
     * @param x
     * @param m
     * @returns
     */
    roundUpToNearest(x: string, m: string): string {
        const rest: bigint = BigInt(x) % BigInt(m)
        const toAdd: bigint = rest === BigInt(0) ? BigInt(0) : BigInt(m)
        return (BigInt(x) - rest + toAdd).toString()
    }

    // helpers

    // returns yocto stNEAR amount equivalent to specified yocto NEAR amount
    estimateStnearOut(amount: string, price: string, accuracy = 5): string {
        return BigInt(price) === BigInt(0)
            ? "0"
            : nearAPI.utils.format.parseNearAmount(
                  (Number(BigInt(amount + "0".repeat(accuracy)) / BigInt(price)) / 10 ** accuracy).toString()
              )!
    }

    async makeTransaction(
        receiverId: string,
        actions: nearAPI.transactions.Action[],
        nonceOffset = 1
    ): Promise<nearAPI.transactions.Transaction> {
        const [accessKey, block] = await Promise.all([
            window.account.accessKeyForTransaction(receiverId, actions),
            window.near.connection.provider.block({ finality: "final" })
        ])

        if (!accessKey) {
            throw new Error(`Cannot find matching key for transaction sent to ${receiverId}`)
        }

        const blockHash = baseDecode(block.header.hash)

        const publicKey = nearAPI.utils.PublicKey.from(accessKey.public_key)
        const nonce = accessKey.access_key.nonce + nonceOffset

        return nearAPI.transactions.createTransaction(
            window.account.accountId,
            publicKey,
            receiverId,
            nonce,
            actions,
            blockHash
        )
    }

    // Takes array of Transaction Promises and redirects the user to the wallet page to sign them.
    async passToWallet(preTXs: Promise<nearAPI.transactions.Transaction[]>[]): Promise<void> {
        const TXs = await Promise.all(preTXs)
        window.walletAccount.requestSignTransactions({
            transactions: TXs.flat(),
            callbackUrl: window.location.href
        })
    }
}
