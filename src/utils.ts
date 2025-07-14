// src/utils.ts
//
// 该文件包含整个应用可重用的通用工具函数和类。

/**
 * RoundRobinSelector 类实现了带随机洗牌的循环选择逻辑。
 * 它确保在所有元素都被使用之前，每个元素只被选择一次。
 * 当所有元素都用完后，它会重置并重新洗牌，从而实现均匀的随机轮询。
 */
export class RoundRobinSelector<T> {
    private originalItems: T[];
    private availableItems: T[];
    private usedItems: T[] = [];

    constructor(items: T[]) {
        this.originalItems = [...items];
        this.availableItems = this._shuffle([...items]);
    }

    /**
     * 使用 Fisher-Yates 洗牌算法和密码学安全随机数生成器 (crypto.getRandomValues) 随机打乱数组。
     * 这提供了比 Math.random() 更高质量、更均匀的随机性。
     * @param array 要打乱的数组。
     * @returns 打乱后的数组。
     */
    private _shuffle(array: T[]): T[] {
        let currentIndex = array.length;
        const randomValues = new Uint32Array(1);

        while (currentIndex !== 0) {
            // 生成一个密码学安全的随机索引
            crypto.getRandomValues(randomValues);
            const randomIndex = randomValues[0] % currentIndex;
            currentIndex--;

            // 交换元素
            [array[currentIndex], array[randomIndex]] = [
                array[randomIndex], array[currentIndex]];
        }
        return array;
    }

    /**
     * 获取下一个可用元素。如果所有元素都已使用，则重置并重新洗牌。
     * @returns 下一个元素或 undefined（如果原始列表为空）。
     */
    public next(): T | undefined {
        if (this.originalItems.length === 0) {
            return undefined;
        }

        if (this.availableItems.length === 0) {
            // 所有元素都已用完，重置并重新洗牌
            this.availableItems = this._shuffle([...this.originalItems]);
            this.usedItems = [];
        }

        const selected = this.availableItems.shift(); // 取出第一个元素
        if (selected !== undefined) {
            this.usedItems.push(selected); // 记录为已使用
        }
        return selected;
    }

    /**
     * 强制重置选择器，清空已使用列表并重新洗牌。
     */
    public reset(): void {
        this.availableItems = this._shuffle([...this.originalItems]);
        this.usedItems = [];
    }
}