import Foundation

struct OrbContentPixelFrame: Equatable, Sendable {
    let width: Int
    let height: Int
    let bytesPerRow: Int
    let rgbaBytes: [UInt8]

    init(width: Int, height: Int, bytesPerRow: Int? = nil, rgbaBytes: [UInt8]) {
        self.width = width
        self.height = height
        self.bytesPerRow = bytesPerRow ?? max(0, width * 4)
        self.rgbaBytes = rgbaBytes
    }
}

struct OrbCircularMask: Equatable, Sendable {
    let centerX: Double
    let centerY: Double
    let radius: Double

    static func centered(in frame: OrbContentPixelFrame) -> Self {
        Self(
            centerX: Double(frame.width) / 2,
            centerY: Double(frame.height) / 2,
            radius: Double(min(frame.width, frame.height)) / 2
        )
    }
}

struct OrbLuminanceSignature: Equatable, Sendable {
    let sampleCount: Int
    let values: [UInt8]
}

struct OrbContentRisk: Equatable, Sendable {
    let edgeDensity: Double
    let localContrastSalience: Double
    let luminanceVariance: Double
    let colorEntropy: Double
    let regionalDifference: Double
    let temporalChange: Double
    let extremeToneBonus: Double
    let captureConfidence: Double
    let totalRisk: Double
}

enum OrbContentAnalysisUnknownReason: Equatable, Sendable {
    case invalidDimensions
    case invalidPixelData
    case emptyMask
    case zeroOrTransparentCapture
}

enum OrbContentAnalysis: Equatable, Sendable {
    case known(risk: OrbContentRisk, signature: OrbLuminanceSignature)
    case unknown(OrbContentAnalysisUnknownReason)

    var risk: OrbContentRisk? {
        guard case let .known(risk, _) = self else {
            return nil
        }
        return risk
    }
}

enum OrbContentRiskAnalyzer {
    private struct EdgeAnalysis {
        let density: Double
        let localContrastSalience: Double
    }

    private struct Sample {
        let x: Int
        let y: Int
        let red: UInt8
        let green: UInt8
        let blue: UInt8
        let alpha: UInt8
        let luminance: Double
    }

    static func analyze(
        frame: OrbContentPixelFrame,
        mask requestedMask: OrbCircularMask? = nil,
        previousSignature: OrbLuminanceSignature? = nil
    ) -> OrbContentAnalysis {
        guard frame.width >= 3, frame.height >= 3, frame.bytesPerRow >= frame.width * 4 else {
            return .unknown(.invalidDimensions)
        }
        guard frame.height <= Int.max / frame.bytesPerRow,
              frame.rgbaBytes.count >= frame.height * frame.bytesPerRow else {
            return .unknown(.invalidPixelData)
        }

        let mask = requestedMask ?? .centered(in: frame)
        guard mask.radius > 0,
              mask.centerX.isFinite,
              mask.centerY.isFinite,
              mask.radius.isFinite else {
            return .unknown(.emptyMask)
        }

        let samples = samples(in: frame, mask: mask)
        guard samples.count >= 9 else {
            return .unknown(.emptyMask)
        }

        let zeroRGBA = samples.allSatisfy {
            $0.red == 0 && $0.green == 0 && $0.blue == 0 && $0.alpha == 0
        }
        let transparentCount = samples.reduce(into: 0) { count, sample in
            if sample.alpha < 16 {
                count += 1
            }
        }
        guard !zeroRGBA, Double(transparentCount) / Double(samples.count) < 0.95 else {
            return .unknown(.zeroOrTransparentCapture)
        }

        let luminances = samples.map(\.luminance)
        let meanLuminance = luminances.reduce(0, +) / Double(luminances.count)
        let standardDeviation = sqrt(
            luminances.reduce(0) { sum, value in
                let delta = value - meanLuminance
                return sum + delta * delta
            } / Double(luminances.count)
        )

        let edgeAnalysis = edgeAnalysis(samples: samples, frame: frame, mask: mask)
        let edgeDensity = edgeAnalysis.density
        let localContrastSalience = edgeAnalysis.localContrastSalience
        let luminanceVariance = clamp01(standardDeviation / 0.25)
        let colorEntropy = colorEntropy(samples: samples)
        let regionalDifference = regionalDifference(
            samples: samples,
            mask: mask
        )

        let signature = OrbLuminanceSignature(
            sampleCount: samples.count,
            values: luminances.map { UInt8((clamp01($0) * 255).rounded()) }
        )
        let temporalChange = temporalChange(
            current: signature,
            previous: previousSignature
        )
        let extremeToneBonus = extremeToneBonus(
            meanLuminance: meanLuminance,
            standardDeviation: standardDeviation,
            edgeDensity: edgeDensity,
            colorEntropy: colorEntropy
        )
        let totalRisk = clamp01(
            0.30 * edgeDensity
                + 0.25 * localContrastSalience
                + 0.15 * luminanceVariance
                + 0.10 * colorEntropy
                + 0.10 * regionalDifference
                + 0.10 * temporalChange
                - 0.05 * extremeToneBonus
        )

        return .known(
            risk: OrbContentRisk(
                edgeDensity: edgeDensity,
                localContrastSalience: localContrastSalience,
                luminanceVariance: luminanceVariance,
                colorEntropy: colorEntropy,
                regionalDifference: regionalDifference,
                temporalChange: temporalChange,
                extremeToneBonus: extremeToneBonus,
                captureConfidence: 1,
                totalRisk: totalRisk
            ),
            signature: signature
        )
    }

    private static func samples(
        in frame: OrbContentPixelFrame,
        mask: OrbCircularMask
    ) -> [Sample] {
        let radiusSquared = mask.radius * mask.radius
        var result: [Sample] = []
        let minimumX = max(0, Int(floor(mask.centerX - mask.radius)))
        let maximumX = min(frame.width, Int(ceil(mask.centerX + mask.radius)))
        let minimumY = max(0, Int(floor(mask.centerY - mask.radius)))
        let maximumY = min(frame.height, Int(ceil(mask.centerY + mask.radius)))
        guard minimumX < maximumX, minimumY < maximumY else {
            return []
        }
        result.reserveCapacity((maximumX - minimumX) * (maximumY - minimumY))

        for y in minimumY..<maximumY {
            for x in minimumX..<maximumX {
                let dx = (Double(x) + 0.5) - mask.centerX
                let dy = (Double(y) + 0.5) - mask.centerY
                guard dx * dx + dy * dy <= radiusSquared else {
                    continue
                }

                let offset = y * frame.bytesPerRow + x * 4
                let red = frame.rgbaBytes[offset]
                let green = frame.rgbaBytes[offset + 1]
                let blue = frame.rgbaBytes[offset + 2]
                let alpha = frame.rgbaBytes[offset + 3]
                let luminance = (
                    0.2126 * Double(red)
                        + 0.7152 * Double(green)
                        + 0.0722 * Double(blue)
                ) / 255
                result.append(
                    Sample(
                        x: x,
                        y: y,
                        red: red,
                        green: green,
                        blue: blue,
                        alpha: alpha,
                        luminance: luminance
                    )
                )
            }
        }
        return result
    }

    private static func edgeAnalysis(
        samples: [Sample],
        frame: OrbContentPixelFrame,
        mask: OrbCircularMask
    ) -> EdgeAnalysis {
        let histogramBucketCount = 1_024
        var strongEdgeCount = 0
        var subtleEdgeCount = 0
        var gradientSum = 0.0
        var gradientCount = 0
        var gradientHistogram = Array(repeating: 0, count: histogramBucketCount)

        for sample in samples {
            var gradient = 0.0
            if let right = luminance(
                atX: sample.x + 1,
                y: sample.y,
                in: frame,
                mask: mask
            ) {
                gradient = max(gradient, abs(right - sample.luminance))
            }
            if let below = luminance(
                atX: sample.x,
                y: sample.y + 1,
                in: frame,
                mask: mask
            ) {
                gradient = max(gradient, abs(below - sample.luminance))
            }
            let bucket = min(
                histogramBucketCount - 1,
                max(0, Int((gradient * Double(histogramBucketCount - 1)).rounded()))
            )
            gradientHistogram[bucket] += 1
            if gradient >= 0.012 {
                subtleEdgeCount += 1
            }
            guard gradient > 0 else {
                continue
            }
            gradientCount += 1
            gradientSum += gradient
            if gradient >= 0.025 {
                strongEdgeCount += 1
            }
        }

        guard gradientCount > 0 else {
            return EdgeAnalysis(density: 0, localContrastSalience: 0)
        }
        let strongEdgeRatio = Double(strongEdgeCount) / Double(samples.count)
        let meanGradient = gradientSum / Double(gradientCount)
        let density = clamp01(
            0.65 * strongEdgeRatio
                + 0.35 * clamp01(meanGradient / 0.20)
        )

        let percentileRank = Int((Double(samples.count - 1) * 0.90).rounded())
        var accumulatedCount = 0
        var percentileBucket = 0
        for (bucket, count) in gradientHistogram.enumerated() {
            accumulatedCount += count
            if accumulatedCount > percentileRank {
                percentileBucket = bucket
                break
            }
        }
        let highPercentileGradient =
            Double(percentileBucket) / Double(histogramBucketCount - 1)
        let contrastStrength = clamp01((highPercentileGradient - 0.004) / 0.025)
        let subtleEdgeCoverage = Double(subtleEdgeCount) / Double(samples.count)
        let normalizedCoverage = clamp01(subtleEdgeCoverage / 0.08)
        let localContrastSalience = clamp01(
            0.70 * contrastStrength + 0.30 * normalizedCoverage
        )
        return EdgeAnalysis(
            density: density,
            localContrastSalience: localContrastSalience
        )
    }

    private static func colorEntropy(samples: [Sample]) -> Double {
        var buckets = Array(repeating: 0, count: 512)
        var populatedBucketCount = 0
        for sample in samples {
            let bucket = (Int(sample.red >> 5) << 6)
                | (Int(sample.green >> 5) << 3)
                | Int(sample.blue >> 5)
            if buckets[bucket] == 0 {
                populatedBucketCount += 1
            }
            buckets[bucket] += 1
        }
        guard populatedBucketCount > 1 else {
            return 0
        }

        let count = Double(samples.count)
        let entropy = buckets.reduce(0.0) { result, bucketCount in
            guard bucketCount > 0 else {
                return result
            }
            let probability = Double(bucketCount) / count
            return result - probability * log2(probability)
        }
        let maximumEntropy = log2(Double(min(512, samples.count)))
        return maximumEntropy > 0 ? clamp01(entropy / maximumEntropy) : 0
    }

    private static func regionalDifference(
        samples: [Sample],
        mask: OrbCircularMask
    ) -> Double {
        let gridSize = 4
        let minimumX = mask.centerX - mask.radius
        let minimumY = mask.centerY - mask.radius
        let diameter = mask.radius * 2
        guard diameter > 0 else {
            return 0
        }

        var sums = Array(repeating: 0.0, count: gridSize * gridSize)
        var counts = Array(repeating: 0, count: gridSize * gridSize)
        for sample in samples {
            let column = min(
                gridSize - 1,
                max(0, Int((Double(sample.x) - minimumX) / diameter * Double(gridSize)))
            )
            let row = min(
                gridSize - 1,
                max(0, Int((Double(sample.y) - minimumY) / diameter * Double(gridSize)))
            )
            let index = row * gridSize + column
            sums[index] += sample.luminance
            counts[index] += 1
        }

        let means: [Double?] = zip(sums, counts).map { sum, count in
            count > 0 ? sum / Double(count) : nil
        }
        var differences: [Double] = []
        for row in 0..<gridSize {
            for column in 0..<gridSize {
                let index = row * gridSize + column
                guard let mean = means[index] else {
                    continue
                }
                if column + 1 < gridSize, let neighbor = means[index + 1] {
                    differences.append(abs(mean - neighbor))
                }
                if row + 1 < gridSize, let neighbor = means[index + gridSize] {
                    differences.append(abs(mean - neighbor))
                }
            }
        }
        guard !differences.isEmpty else {
            return 0
        }
        return clamp01((differences.reduce(0, +) / Double(differences.count)) / 0.25)
    }

    private static func temporalChange(
        current: OrbLuminanceSignature,
        previous: OrbLuminanceSignature?
    ) -> Double {
        guard let previous,
              previous.sampleCount == current.sampleCount,
              previous.values.count == current.values.count,
              !current.values.isEmpty else {
            return 0
        }

        let meanDifference = zip(current.values, previous.values).reduce(0.0) { result, pair in
            result + abs(Double(pair.0) - Double(pair.1)) / 255
        } / Double(current.values.count)
        return clamp01(meanDifference / 0.20)
    }

    private static func extremeToneBonus(
        meanLuminance: Double,
        standardDeviation: Double,
        edgeDensity: Double,
        colorEntropy: Double
    ) -> Double {
        guard meanLuminance <= 0.05 || meanLuminance >= 0.95,
              standardDeviation <= 0.02,
              edgeDensity <= 0.05,
              colorEntropy <= 0.10 else {
            return 0
        }
        return 1
    }

    private static func luminance(
        atX x: Int,
        y: Int,
        in frame: OrbContentPixelFrame,
        mask: OrbCircularMask
    ) -> Double? {
        guard x >= 0, x < frame.width, y >= 0, y < frame.height else {
            return nil
        }
        let dx = (Double(x) + 0.5) - mask.centerX
        let dy = (Double(y) + 0.5) - mask.centerY
        guard dx * dx + dy * dy <= mask.radius * mask.radius else {
            return nil
        }
        let offset = y * frame.bytesPerRow + x * 4
        return (
            0.2126 * Double(frame.rgbaBytes[offset])
                + 0.7152 * Double(frame.rgbaBytes[offset + 1])
                + 0.0722 * Double(frame.rgbaBytes[offset + 2])
        ) / 255
    }

    private static func clamp01(_ value: Double) -> Double {
        min(1, max(0, value))
    }
}
