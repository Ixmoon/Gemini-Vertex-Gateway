// src/utils.ts
//
// 该文件包含整个应用可重用的通用工具函数和类。

/**
 * OptimizedRoundRobinSelector 类为单实例、有状态的场景实现了一个高效的、
 * 不重复的随机轮询选择器。
 *
 * 核心优化:
 * 1. **O(1) 复杂度**: 使用索引 (`currentIndex`) 代替 `Array.prototype.shift()`，
 *    将 `next()` 操作的时间复杂度从 O(n) 降低到 O(1)。
 * 2. **低内存占用**: 只维护一个洗牌后的列表和一个索引，避免了多个数组的开销。
 *
 * 工作原理:
 * 1. 在初始化时，它会对原始列表进行一次高质量的随机洗牌。
 * 2. 每次调用 `next()`，它会返回当前索引处的元素，然后将索引递增。
 * 3. 当所有元素都分发完毕后，它会自动重新洗牌并重置索引，开始新的一个周期。
 */
export class OptimizedRoundRobinSelector<T> {
    private items: T[];
    private shuffledItems: T[];
    private currentIndex: number;

    constructor(items: T[]) {
        this.items = [...items];
        this.shuffledItems = this._shuffle([...this.items]);
        this.currentIndex = 0;
    }

    /**
     * 使用 Fisher-Yates 洗牌算法和密码学安全随机数生成器 (crypto.getRandomValues) 随机打乱数组。
     * @param array 要打乱的数组。
     * @returns 打乱后的新数组。
     */
    private _shuffle(array: T[]): T[] {
        let currentIndex = array.length;
        const randomValues = new Uint32Array(1);

        while (currentIndex !== 0) {
            crypto.getRandomValues(randomValues);
            const randomIndex = randomValues[0] % currentIndex;
            currentIndex--;
            [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
        }
        return array;
    }

    /**
     * 高效地获取下一个可用元素。
     * @returns 下一个元素，如果原始列表为空则返回 undefined。
     */
    public next(): T | undefined {
        if (this.items.length === 0) {
            return undefined;
        }

        if (this.currentIndex >= this.shuffledItems.length) {
            // 所有元素都已用完，重置并重新洗牌
            this.shuffledItems = this._shuffle([...this.items]);
            this.currentIndex = 0;
        }

        const selected = this.shuffledItems[this.currentIndex];
        this.currentIndex++;
        return selected;
    }

    /**
     * 强制重置选择器，重新洗牌并从头开始。
     */
    public reset(): void {
        this.shuffledItems = this._shuffle([...this.items]);
        this.currentIndex = 0;
    }
}