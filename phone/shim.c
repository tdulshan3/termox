/* Supplies the OpenCL 3.0 entry points the Adreno 650 driver (2021) lacks.
   ggml-opencl needs them to resolve at dlopen time; instrumenting this showed
   it never actually calls them, so forwarding to the 1.2 equivalents is safe. */
#include <dlfcn.h>
#include <stddef.h>
#include <stdint.h>

static void *sym(const char *n) { return dlsym(RTLD_DEFAULT, n); }

void *clCreateBufferWithProperties(void *ctx, const uint64_t *props,
                                   uint64_t flags, size_t size,
                                   void *host_ptr, int32_t *err) {
    void *(*real)(void *, uint64_t, size_t, void *, int32_t *) =
        (void *(*)(void *, uint64_t, size_t, void *, int32_t *)) sym("clCreateBuffer");
    if (!real) { if (err) *err = -6; return NULL; }
    (void) props;
    return real(ctx, flags, size, host_ptr, err);
}

void *clCreateImageWithProperties(void *ctx, const uint64_t *props, uint64_t flags,
                                  const void *fmt, const void *desc,
                                  void *host_ptr, int32_t *err) {
    void *(*real)(void *, uint64_t, const void *, const void *, void *, int32_t *) =
        (void *(*)(void *, uint64_t, const void *, const void *, void *, int32_t *)) sym("clCreateImage");
    if (!real) { if (err) *err = -6; return NULL; }
    (void) props;
    return real(ctx, flags, fmt, desc, host_ptr, err);
}
