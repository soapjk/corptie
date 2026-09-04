#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef struct { uint64_t epoch; uint64_t event_id; int trusted; char error_code[64]; } CorptieSourceJournalResult;

static void set_error(CorptieSourceJournalResult *out, const char *code) {
    if (out == NULL) return;
    out->trusted = 0;
    snprintf(out->error_code, sizeof(out->error_code), "%s", code);
}

#ifdef __APPLE__
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdlib.h>
#include <sys/event.h>
#include <unistd.h>

#define CORPTIE_MAX_JOURNALS 128
#define CORPTIE_MAX_WATCHES 20000
#define CORPTIE_EVENT_BATCH 256

typedef struct {
    int queue; int *descriptors; size_t descriptor_count; size_t descriptor_capacity;
    uint64_t epoch; uint64_t event_id; int trusted; char *root; pthread_mutex_t lock;
} CorptieSourceJournal;

static CorptieSourceJournal *journals[CORPTIE_MAX_JOURNALS];
static pthread_mutex_t journals_lock = PTHREAD_MUTEX_INITIALIZER;

static int add_watch(CorptieSourceJournal *journal, const char *path) {
    if (journal->descriptor_count >= CORPTIE_MAX_WATCHES) return -2;
    int descriptor = open(path, O_EVTONLY | O_CLOEXEC);
    if (descriptor < 0) return errno == ENOENT ? 1 : -1;
    struct kevent change;
    EV_SET(&change, (uintptr_t)descriptor, EVFILT_VNODE, EV_ADD | EV_ENABLE | EV_CLEAR,
        NOTE_WRITE | NOTE_DELETE | NOTE_EXTEND | NOTE_LINK | NOTE_RENAME | NOTE_REVOKE, 0, NULL);
    if (kevent(journal->queue, &change, 1, NULL, 0, NULL) != 0) { close(descriptor); return -1; }
    if (journal->descriptor_count == journal->descriptor_capacity) {
        size_t capacity = journal->descriptor_capacity == 0 ? 256 : journal->descriptor_capacity * 2;
        int *next = realloc(journal->descriptors, capacity * sizeof(int));
        if (next == NULL) { close(descriptor); return -1; }
        journal->descriptors = next; journal->descriptor_capacity = capacity;
    }
    journal->descriptors[journal->descriptor_count++] = descriptor; return 0;
}

static void clear_watches(CorptieSourceJournal *journal) {
    for (size_t index = 0; index < journal->descriptor_count; index += 1) close(journal->descriptors[index]);
    journal->descriptor_count = 0;
}

static CorptieSourceJournal *lookup(uint64_t handle) {
    pthread_mutex_lock(&journals_lock);
    CorptieSourceJournal *journal = handle < CORPTIE_MAX_JOURNALS ? journals[handle] : NULL;
    pthread_mutex_unlock(&journals_lock); return journal;
}

int corptie_source_journal_start(const char *root, uint64_t *handle, CorptieSourceJournalResult *out) {
    if (root == NULL || handle == NULL || out == NULL) return -1; memset(out, 0, sizeof(*out));
    CorptieSourceJournal *journal = calloc(1, sizeof(*journal));
    if (journal == NULL) { set_error(out, "SOURCE_JOURNAL_UNAVAILABLE"); return -1; }
    journal->queue = kqueue(); journal->trusted = 1; journal->root = strdup(root); pthread_mutex_init(&journal->lock, NULL);
    if (journal->queue < 0 || journal->root == NULL || add_watch(journal, root) != 0) {
        if (journal->queue >= 0) close(journal->queue); free(journal->root); pthread_mutex_destroy(&journal->lock); free(journal);
        set_error(out, "SOURCE_JOURNAL_UNAVAILABLE"); return -1;
    }
    pthread_mutex_lock(&journals_lock); uint64_t slot = 0;
    for (uint64_t index = 1; index < CORPTIE_MAX_JOURNALS; index += 1) if (journals[index] == NULL) { journals[index] = journal; slot = index; break; }
    pthread_mutex_unlock(&journals_lock);
    if (slot == 0) {
        clear_watches(journal); close(journal->queue); free(journal->descriptors); free(journal->root);
        pthread_mutex_destroy(&journal->lock); free(journal); set_error(out, "SOURCE_JOURNAL_CAPACITY"); return -1;
    }
    *handle = slot; out->trusted = 1; return 0;
}

int corptie_source_journal_reset(uint64_t handle, const char *const paths[], size_t count, CorptieSourceJournalResult *out) {
    if (out == NULL) return -1; memset(out, 0, sizeof(*out)); CorptieSourceJournal *journal = lookup(handle);
    if (journal == NULL) { set_error(out, "SOURCE_JOURNAL_HANDLE_INVALID"); return -1; }
    pthread_mutex_lock(&journal->lock); clear_watches(journal); int failed = add_watch(journal, journal->root) != 0;
    for (size_t index = 0; index < count && !failed; index += 1) if (add_watch(journal, paths[index]) < 0) failed = 1;
    journal->epoch += 1; journal->event_id += 1; if (failed) journal->trusted = 0;
    out->epoch = journal->epoch; out->event_id = journal->event_id; out->trusted = journal->trusted;
    if (failed) snprintf(out->error_code, sizeof(out->error_code), "%s", "SOURCE_JOURNAL_WATCH_FAILED");
    pthread_mutex_unlock(&journal->lock); return 0;
}

int corptie_source_journal_barrier(uint64_t handle, CorptieSourceJournalResult *out) {
    if (out == NULL) return -1; memset(out, 0, sizeof(*out)); CorptieSourceJournal *journal = lookup(handle);
    if (journal == NULL) { set_error(out, "SOURCE_JOURNAL_HANDLE_INVALID"); return -1; }
    pthread_mutex_lock(&journal->lock); struct kevent events[CORPTIE_EVENT_BATCH]; const struct timespec no_wait = { 0, 0 }; int observed;
    do {
        observed = kevent(journal->queue, NULL, 0, events, CORPTIE_EVENT_BATCH, &no_wait);
        if (observed < 0) { journal->trusted = 0; break; }
        for (int index = 0; index < observed; index += 1) {
            journal->epoch += 1; journal->event_id += 1;
            if ((events[index].flags & EV_ERROR) != 0 || (events[index].fflags & NOTE_REVOKE) != 0) journal->trusted = 0;
        }
    } while (observed == CORPTIE_EVENT_BATCH);
    out->epoch = journal->epoch; out->event_id = journal->event_id; out->trusted = journal->trusted;
    if (!out->trusted) snprintf(out->error_code, sizeof(out->error_code), "%s", "SOURCE_JOURNAL_UNCERTAIN");
    pthread_mutex_unlock(&journal->lock); return 0;
}

int corptie_source_journal_stop(uint64_t handle) {
    pthread_mutex_lock(&journals_lock); CorptieSourceJournal *journal = handle < CORPTIE_MAX_JOURNALS ? journals[handle] : NULL;
    if (journal != NULL) journals[handle] = NULL; pthread_mutex_unlock(&journals_lock); if (journal == NULL) return -1;
    pthread_mutex_lock(&journal->lock); clear_watches(journal); close(journal->queue); free(journal->descriptors); free(journal->root);
    pthread_mutex_unlock(&journal->lock); pthread_mutex_destroy(&journal->lock); free(journal); return 0;
}

#else
int corptie_source_journal_start(const char *root, uint64_t *handle, CorptieSourceJournalResult *out) {
    (void)root; (void)handle; memset(out, 0, sizeof(*out)); set_error(out, "SOURCE_JOURNAL_UNSUPPORTED"); return -1;
}
int corptie_source_journal_reset(uint64_t handle, const char *const paths[], size_t count, CorptieSourceJournalResult *out) {
    (void)handle; (void)paths; (void)count; memset(out, 0, sizeof(*out)); set_error(out, "SOURCE_JOURNAL_UNSUPPORTED"); return -1;
}
int corptie_source_journal_barrier(uint64_t handle, CorptieSourceJournalResult *out) {
    (void)handle; memset(out, 0, sizeof(*out)); set_error(out, "SOURCE_JOURNAL_UNSUPPORTED"); return -1;
}
int corptie_source_journal_stop(uint64_t handle) { (void)handle; return -1; }
#endif
