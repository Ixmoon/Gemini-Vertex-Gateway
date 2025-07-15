// src/utils.ts
//
// 该文件包含整个应用可重用的通用工具函数和类。

/**
 * DeterministicShufflingSelector 类实现了一个无状态但确定性的选择逻辑。
 * 它非常适合 Deno Deploy 等无状态环境，同时提供了比纯随机更好的分发均匀性。
 *
 * 工作原理:
 * 1. **时间窗口**: 它使用一个离散的时间窗口（例如每10分钟）作为种子。
 * 2. **确定性洗牌**: 它使用一个确定性的伪随机数生成器 (PRNG)，根据时间种子对原始列表进行洗牌。
 *    这意味着在同一个时间窗口内，列表的“随机”顺序是固定的。
 * 3. **基于 Key 的选择**: 它使用传入的 key (例如用户 API Key) 的哈希值，从洗牌后的列表中选择一个稳定的项。
 *
 * 优点:
 * - **无状态**: 无需在请求之间存储状态。
 * - **均匀负载**: 随着时间窗口的变化，密钥分发是均匀的。
 * - **请求稳定性**: 同一个用户在同一个时间窗口内会稳定地命中同一个后端密钥。
 */
export class DeterministicShufflingSelector<T> {
    private items: T[];
    private timeSlotMinutes: number;
    private cache: { seed: number; shuffledItems: T[] } | null = null;

    constructor(items: T[], timeSlotMinutes = 10) {
        this.items = [...items];
        this.timeSlotMinutes = timeSlotMinutes;
    }

    /**
     * 将字符串转换为一个简单的、不安全的哈希值（整数）。
     * @param str 输入字符串
     * @returns 一个整数哈希值
     */
    private _stringToHash(str: string): number {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = (hash << 5) - hash + char;
            hash |= 0; // 转换为 32 位有符号整数
        }
        return Math.abs(hash);
    }

    /**
     * 使用 LCG (线性同余) 伪随机数生成器和一个种子，对数组进行确定性洗牌。
     * @param array 要洗牌的数组
     * @param seed 随机数生成器的种子
     * @returns 洗牌后的新数组
     */
    private _deterministicShuffle(array: T[], seed: number): T[] {
        const shuffled = [...array];
        let currentIndex = shuffled.length;

        // LCG PRNG
        const a = 1664525;
        const c = 1013904223;
        const m = 2 ** 32;
        let randomSeed = seed;

        const nextRandom = () => {
            randomSeed = (a * randomSeed + c) % m;
            return randomSeed / m;
        };

        while (currentIndex !== 0) {
            const randomIndex = Math.floor(nextRandom() * currentIndex);
            currentIndex--;
            [shuffled[currentIndex], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[currentIndex]];
        }
        return shuffled;
    }

    /**
     * 根据给定的 key，从列表中确定性地选择一个元素。
     * @param key 用于确定选择的字符串，例如用户 API Key。
     * @returns 列表中的一个元素，如果列表为空则返回 undefined。
     */
    public next(key: string): T | undefined {
        if (this.items.length === 0) {
            return undefined;
        }

        // 1. 计算当前时间窗口作为洗牌的种子
        const now = Date.now();
        const timeSlotInMillis = this.timeSlotMinutes * 60 * 1000;
        const timeSeed = Math.floor(now / timeSlotInMillis);

        // 2. 检查缓存
        if (this.cache && this.cache.seed === timeSeed) {
            // 缓存命中，直接使用缓存的结果
        } else {
            // 缓存未命中或已过期，重新洗牌并更新缓存
            const shuffled = this._deterministicShuffle(this.items, timeSeed);
            this.cache = { seed: timeSeed, shuffledItems: shuffled };
        }
        const shuffledItems = this.cache.shuffledItems;

        // 3. 使用输入 key 的哈希值从洗牌后的列表中选择一项
        const keyHash = this._stringToHash(key);
        const index = keyHash % shuffledItems.length;

        return shuffledItems[index];
    }
}