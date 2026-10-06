#include "capture.hpp"
#include <chrono>
#include <cstring>
#include <d3d11.h>
#include <dwmapi.h>
#include <dxgi.h>
#include <fcntl.h>
#include <io.h>
#include <iostream>
#include <string>
#include <vector>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <windows.h>

#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <winrt/Windows.Graphics.DirectX.h>
using namespace winrt;

using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;
using namespace winrt::Windows::Graphics::DirectX::Direct3D11;
static constexpr uint32_t maxBytes = 64 * 1024 * 1024;
static double nowMs() {
  return std::chrono::duration<double, std::milli>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}
class WindowsCapture final : public CaptureSource {
  com_ptr<ID3D11Device> device;
  com_ptr<ID3D11DeviceContext> context;
  IDirect3DDevice interop{nullptr};
  GraphicsCaptureItem item{nullptr};
  Direct3D11CaptureFramePool pool{nullptr};
  GraphicsCaptureSession session{nullptr};
  com_ptr<ID3D11Texture2D> staging;
  winrt::Windows::Graphics::SizeInt32 size{};
  HWND target{};
  DWORD targetPid{};
  double lastFrame = 0;

public:
  ~WindowsCapture() { stop(); }
  void stop() noexcept override {
    try {
      if (session)
        session.Close();
    } catch (...) {
    }
    session = nullptr;
    try {
      if (pool)
        pool.Close();
    } catch (...) {
    }
    pool = nullptr;
    item = nullptr;
    staging = nullptr;
    interop = nullptr;
    context = nullptr;
    device = nullptr;
    target = nullptr;
  }
  void start(uintptr_t handle) override {
    auto hwnd = reinterpret_cast<HWND>(handle);
    stop();
    if (!GraphicsCaptureSession::IsSupported())
      throw std::runtime_error(
          "Windows Graphics Capture is unavailable. Use Windows 10 1903+ with "
          "a supported graphics driver.");
    if (!IsWindow(hwnd) || !IsWindowVisible(hwnd) || IsIconic(hwnd))
      throw std::runtime_error("Window is closed, hidden, or minimized. "
                               "Restore it and refresh the window list.");
    UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
    check_hresult(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                                    flags, nullptr, 0, D3D11_SDK_VERSION,
                                    device.put(), nullptr, context.put()));
    auto dxgi = device.as<IDXGIDevice>();
    com_ptr<IInspectable> inspectable;
    check_hresult(
        CreateDirect3D11DeviceFromDXGIDevice(dxgi.get(), inspectable.put()));
    interop = inspectable.as<IDirect3DDevice>();
    auto factory = get_activation_factory<GraphicsCaptureItem,
                                          IGraphicsCaptureItemInterop>();
    check_hresult(factory->CreateForWindow(hwnd, guid_of<GraphicsCaptureItem>(),
                                           put_abi(item)));
    size = item.Size();
    if (size.Width <= 0 || size.Height <= 0 ||
        uint64_t(size.Width) * size.Height * 4 > maxBytes - 32)
      throw std::runtime_error(
          "Window dimensions exceed the 64 MiB preview limit.");
    pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        interop, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size);
    session = pool.CreateCaptureSession(item);
    session.StartCapture();
    target = hwnd;
    GetWindowThreadProcessId(hwnd, &targetPid);
    lastFrame = nowMs();
  }
  std::optional<CapturedFrame> next() override {
    if (!session) {
      throw CaptureError("NOT_CAPTURING", "Select a window and start capture.");
    }
    DWORD pid{};
    GetWindowThreadProcessId(target, &pid);
    if (!IsWindow(target) || pid != targetPid || IsIconic(target)) {
      stop();
      throw CaptureError(
          "WINDOW_UNAVAILABLE",
          "The selected window closed or was minimized. Restore it and start "
          "capture again.");
    }
    auto frame = pool.TryGetNextFrame();
    // A paused consumer must resume with the newest available source frame.
    if (frame) {
      for (int i = 0; i < 2; ++i) {
        auto newer = pool.TryGetNextFrame();
        if (!newer)
          break;
        frame.Close();
        frame = std::move(newer);
      }
    }
    if (!frame) {
      if (nowMs() - lastFrame > 5000) {
        stop();
        throw CaptureError(
            "CAPTURE_STALLED",
            "No frames for five seconds. The application may use protected "
            "or incompatible capture; restore the window or choose another "
            "application.");
      } else {
      }
      return std::nullopt;
    }
    auto current = frame.ContentSize();
    if (current.Width <= 0 || current.Height <= 0 ||
        uint64_t(current.Width) * current.Height * 4 > maxBytes - 32) {
      stop();
      throw CaptureError(
          "INVALID_SIZE",
          "Window dimensions are unavailable or exceed the preview limit.");
    }
    if (current.Width != size.Width || current.Height != size.Height) {
      frame.Close();
      size = current;
      staging = nullptr;
      pool.Recreate(interop, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2,
                    size);

      return std::nullopt;
    }
    auto access = frame.Surface()
                      .as<::Windows::Graphics::DirectX::Direct3D11::
                              IDirect3DDxgiInterfaceAccess>();
    com_ptr<ID3D11Texture2D> texture;
    check_hresult(
        access->GetInterface(guid_of<ID3D11Texture2D>(), texture.put_void()));
    D3D11_TEXTURE2D_DESC desc{};
    texture->GetDesc(&desc);
    if (desc.Width < static_cast<UINT>(size.Width) ||
        desc.Height < static_cast<UINT>(size.Height)) {
      frame.Close();

      return std::nullopt;
    }
    if (staging) {
      D3D11_TEXTURE2D_DESC old{};
      staging->GetDesc(&old);
      if (old.Width != desc.Width || old.Height != desc.Height)
        staging = nullptr;
    }
    if (!staging) {
      desc.Usage = D3D11_USAGE_STAGING;
      desc.BindFlags = 0;
      desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
      desc.MiscFlags = 0;
      check_hresult(device->CreateTexture2D(&desc, nullptr, staging.put()));
    }
    context->CopyResource(staging.get(), texture.get());
    D3D11_MAPPED_SUBRESOURCE mapped{};
    check_hresult(context->Map(staging.get(), 0, D3D11_MAP_READ, 0, &mapped));
    uint32_t w = size.Width, h = size.Height;
    double timestamp = frame.SystemRelativeTime().count() / 10000.0;
    std::vector<uint8_t> bytes(size_t(w) * h * 4);

    for (uint32_t y = 0; y < h; ++y)
      std::memcpy(bytes.data() + size_t(y) * w * 4,
                  static_cast<uint8_t *>(mapped.pData) +
                      size_t(y) * mapped.RowPitch,
                  size_t(w) * 4);
    context->Unmap(staging.get(), 0);
    frame.Close();
    lastFrame = nowMs();
    return CapturedFrame{w, h, timestamp, std::move(bytes)};
  }
};

std::unique_ptr<CaptureSource> makeCaptureSource() {
  return std::make_unique<WindowsCapture>();
}
