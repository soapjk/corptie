#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>

static CFMutableDictionaryRef mcp_query(const char *service, const char *account) {
    CFStringRef service_name = CFStringCreateWithCString(kCFAllocatorDefault, service, kCFStringEncodingUTF8);
    CFStringRef account_name = CFStringCreateWithCString(kCFAllocatorDefault, account, kCFStringEncodingUTF8);
    if (!service_name || !account_name) {
        if (service_name) CFRelease(service_name);
        if (account_name) CFRelease(account_name);
        return NULL;
    }
    CFMutableDictionaryRef query = CFDictionaryCreateMutable(kCFAllocatorDefault, 0,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    if (query) {
        CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
        CFDictionarySetValue(query, kSecAttrService, service_name);
        CFDictionarySetValue(query, kSecAttrAccount, account_name);
    }
    CFRelease(service_name);
    CFRelease(account_name);
    return query;
}

int corptie_mcp_keychain_put(const char *service, const char *account,
    const unsigned char *bytes, size_t length) {
    if (!service || !account || !bytes || length > LONG_MAX) return errSecParam;
    CFMutableDictionaryRef query = mcp_query(service, account);
    if (!query) return errSecAllocate;
    CFDataRef data = CFDataCreate(kCFAllocatorDefault, bytes, (CFIndex)length);
    if (!data) {
        CFRelease(query);
        return errSecAllocate;
    }
    CFDictionarySetValue(query, kSecValueData, data);
    OSStatus status = SecItemAdd(query, NULL);
    if (status == errSecDuplicateItem) {
        CFDictionaryRemoveValue(query, kSecValueData);
        CFMutableDictionaryRef update = CFDictionaryCreateMutable(kCFAllocatorDefault, 0,
            &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
        if (update) {
            CFDictionarySetValue(update, kSecValueData, data);
            status = SecItemUpdate(query, update);
            CFRelease(update);
        } else status = errSecAllocate;
    }
    CFRelease(data);
    CFRelease(query);
    return status;
}

int corptie_mcp_keychain_get(const char *service, const char *account,
    unsigned char **bytes, size_t *length) {
    if (!service || !account || !bytes || !length) return errSecParam;
    *bytes = NULL;
    *length = 0;
    CFMutableDictionaryRef query = mcp_query(service, account);
    if (!query) return errSecAllocate;
    CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
    CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
    CFTypeRef result = NULL;
    OSStatus status = SecItemCopyMatching(query, &result);
    CFRelease(query);
    if (status != errSecSuccess) return status;
    if (!result || CFGetTypeID(result) != CFDataGetTypeID()) {
        if (result) CFRelease(result);
        return errSecInternalComponent;
    }
    CFDataRef data = (CFDataRef)result;
    CFIndex data_length = CFDataGetLength(data);
    unsigned char *copy = malloc((size_t)data_length + 1);
    if (!copy) {
        CFRelease(data);
        return errSecAllocate;
    }
    memcpy(copy, CFDataGetBytePtr(data), (size_t)data_length);
    *bytes = copy;
    *length = (size_t)data_length;
    CFRelease(data);
    return errSecSuccess;
}

int corptie_mcp_keychain_delete(const char *service, const char *account) {
    if (!service || !account) return errSecParam;
    CFMutableDictionaryRef query = mcp_query(service, account);
    if (!query) return errSecAllocate;
    OSStatus status = SecItemDelete(query);
    CFRelease(query);
    return status == errSecItemNotFound ? errSecSuccess : status;
}

void corptie_mcp_keychain_free(unsigned char *bytes, size_t length) {
    if (!bytes) return;
    memset(bytes, 0, length);
    free(bytes);
}
