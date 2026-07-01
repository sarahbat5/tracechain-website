import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

export const options = {
    vus: Number(__ENV.VUS || 2),
    duration: __ENV.DURATION || '30s',
    thresholds: {
        verification_success_rate: ['rate>0.95'],
        verification_latency_ms: ['p(95)<5000'],
    },
};

const RPC_URL = __ENV.RPC_URL || 'https://eth-sepolia.g.alchemy.com/v2/YNUewYuYyCkk0NfofJ-kB';
const CONTRACT_ADDRESS = __ENV.CONTRACT_ADDRESS || '';
const AUTH_CODE = __ENV.AUTH_CODE || 'TC-A1B2C3D4';

const VERIFY_BY_AUTH_CODE_SELECTOR = 'e2616f91';
const GET_PRODUCT_BY_AUTH_CODE_SELECTOR = 'd2bf304b';

const verificationLatency = new Trend('verification_latency_ms', true);
const successfulVerifications = new Counter('successful_verifications');
const verificationSuccessRate = new Rate('verification_success_rate');

function strip0x(value) {
    return String(value || '').replace(/^0x/i, '');
}

function pad64(hex) {
    return strip0x(hex).padStart(64, '0');
}

function asciiToHex(value) {
    return Array.from(String(value || ''))
        .map((char) => char.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('');
}

function padRightToWord(hex) {
    const remainder = hex.length % 64;
    return remainder ? hex + '0'.repeat(64 - remainder) : hex;
}

function encodeStringCall(selector, value) {
    const encodedValue = asciiToHex(value);
    const byteLength = encodedValue.length / 2;
    return `0x${selector}${pad64('20')}${pad64(byteLength.toString(16))}${padRightToWord(encodedValue)}`;
}

function ethCall(data) {
    const payload = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [
            {
                to: CONTRACT_ADDRESS,
                data,
            },
            'latest',
        ],
    });

    return http.post(RPC_URL, payload, {
        headers: { 'Content-Type': 'application/json' },
        tags: { method: 'eth_call' },
    });
}

function isTrueResult(result) {
    return strip0x(result).endsWith('1');
}

export default function () {
    if (!/^0x[a-fA-F0-9]{40}$/.test(CONTRACT_ADDRESS)) {
        throw new Error('Set CONTRACT_ADDRESS to the deployed TraceChain contract address.');
    }

    const start = Date.now();
    const verifyRes = ethCall(encodeStringCall(VERIFY_BY_AUTH_CODE_SELECTOR, AUTH_CODE));
    const verified = verifyRes.status === 200 && isTrueResult(verifyRes.json('result'));

    let productFetched = false;
    if (verified) {
        const productRes = ethCall(encodeStringCall(GET_PRODUCT_BY_AUTH_CODE_SELECTOR, AUTH_CODE));
        productFetched = productRes.status === 200 && Boolean(productRes.json('result'));
    }

    const latencyMs = Date.now() - start;
    verificationLatency.add(latencyMs);

    const success = verified && productFetched;
    verificationSuccessRate.add(success);
    if (success) successfulVerifications.add(1);

    check(null, {
        'verification request completed successfully': () => success,
    });
}
