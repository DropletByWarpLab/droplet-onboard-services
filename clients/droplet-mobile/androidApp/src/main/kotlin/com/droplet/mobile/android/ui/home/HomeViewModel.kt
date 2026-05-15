package com.droplet.mobile.android.ui.home

import androidx.lifecycle.ViewModel
import com.droplet.mobile.CredentialStore
import com.droplet.mobile.DropletSession
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class HomeViewModel(
    private val credentialStore: CredentialStore,
) : ViewModel() {

    private val _session = MutableStateFlow(credentialStore.load())
    val session: StateFlow<DropletSession?> = _session.asStateFlow()

    fun forget() {
        credentialStore.clear()
        _session.value = null
    }
}
