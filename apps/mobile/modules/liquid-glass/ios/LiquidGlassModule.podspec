Pod::Spec.new do |s|
  s.name           = 'LiquidGlassModule'
  s.version        = '1.0.0'
  s.summary        = 'Real UIGlassEffect backdrop for Expo/RN views.'
  s.description    = 'A local Expo module exposing Apple\'s Liquid Glass material, with a UIBlurEffect fallback below iOS 26.'
  s.license        = 'MIT'
  s.author         = 'hat'
  s.homepage       = 'https://github.com/t3code/hat'
  s.platforms      = { :ios => '15.1', :tvos => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
